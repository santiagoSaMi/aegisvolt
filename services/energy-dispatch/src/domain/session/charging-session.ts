import { InvalidValueError } from '../shared/domain-error.ts';
import type { ConnectorId, SagaId, SessionId, StationId } from '../shared/identifiers.ts';
import { TelemetryRecord, type TelemetryReading } from '../telemetry/telemetry-record.ts';
import {
  SessionAbortedError,
  SessionAlreadyCompletedError,
  SessionNotActiveError,
  SessionTermsMismatchError,
} from './errors.ts';
import type { ChargerFault, RequestedEnergy } from './value-objects.ts';

export const SESSION_STATUSES = ['ACTIVE', 'FAILED', 'ABORTED', 'COMPLETED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Motivo de una parada normal (COMPLETED). */
export const STOP_REASONS = ['USER_REQUEST', 'TARGET_REACHED', 'OPERATOR_REQUEST'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export type AbortOutcome = 'ABORTED' | 'ALREADY_ABORTED' | 'ALREADY_FAILED';
export type StopOutcome = 'STOPPED' | 'ALREADY_STOPPED';

/** Transición registrada (auditoría del ciclo de vida de la sesión). */
export interface SessionTransition {
  readonly from: SessionStatus | undefined;
  readonly to: SessionStatus;
  readonly at: Date;
  readonly reason?: string;
}

/** Términos de la activación: identifican la petición para la idempotencia. */
export interface SessionTerms {
  readonly sagaId: SagaId;
  readonly stationId: StationId;
  readonly connectorId: ConnectorId;
  readonly requestedEnergy: RequestedEnergy;
}

export interface LastTelemetry {
  readonly timestamp: Date;
  readonly energyKwh: number;
}

export interface ChargingSessionProps {
  readonly id: SessionId;
  readonly terms: SessionTerms;
  readonly status: SessionStatus;
  readonly fault?: ChargerFault;
  readonly stopReason?: StopReason;
  readonly lastTelemetry?: LastTelemetry;
  readonly transitions: readonly SessionTransition[];
  readonly startedAt: Date;
  readonly endedAt?: Date;
  readonly updatedAt: Date;
}

/**
 * Sesión de despacho de energía (paso 3 de la SAGA, pivote). Ciclo de vida:
 *
 *   (activación OK) ACTIVE ──stop──▶ COMPLETED
 *                     └─────abort───▶ ABORTED   (compensación)
 *   (falla física del cargador) FAILED
 *
 * Invariantes: FAILED ⇔ tiene `fault`; terminal ⇔ tiene `endedAt`;
 * COMPLETED ⇔ tiene `stopReason`. Cada cambio de estado queda en `transitions`.
 */
export class ChargingSession {
  readonly id: SessionId;
  readonly terms: SessionTerms;
  readonly status: SessionStatus;
  readonly fault: ChargerFault | undefined;
  readonly stopReason: StopReason | undefined;
  readonly lastTelemetry: LastTelemetry | undefined;
  readonly transitions: readonly SessionTransition[];
  readonly startedAt: Date;
  readonly endedAt: Date | undefined;
  readonly updatedAt: Date;

  private constructor(props: ChargingSessionProps) {
    this.id = props.id;
    this.terms = props.terms;
    this.status = props.status;
    this.fault = props.fault;
    this.stopReason = props.stopReason;
    this.lastTelemetry = props.lastTelemetry;
    this.transitions = props.transitions;
    this.startedAt = props.startedAt;
    this.endedAt = props.endedAt;
    this.updatedAt = props.updatedAt;
  }

  static activated(id: SessionId, terms: SessionTerms, now: Date): ChargingSession {
    return new ChargingSession({
      id,
      terms,
      status: 'ACTIVE',
      transitions: [{ from: undefined, to: 'ACTIVE', at: now }],
      startedAt: now,
      updatedAt: now,
    });
  }

  static failed(
    id: SessionId,
    terms: SessionTerms,
    fault: ChargerFault,
    now: Date,
  ): ChargingSession {
    return new ChargingSession({
      id,
      terms,
      status: 'FAILED',
      fault,
      transitions: [{ from: undefined, to: 'FAILED', at: now, reason: fault.code }],
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });
  }

  static restore(props: ChargingSessionProps): ChargingSession {
    if ((props.status === 'FAILED') !== (props.fault !== undefined)) {
      throw new InvalidValueError('fault', 'obligatorio si y solo si la sesión está FAILED');
    }
    if ((props.status !== 'ACTIVE') !== (props.endedAt !== undefined)) {
      throw new InvalidValueError('endedAt', 'obligatorio si y solo si la sesión terminó');
    }
    if ((props.status === 'COMPLETED') !== (props.stopReason !== undefined)) {
      throw new InvalidValueError(
        'stopReason',
        'obligatorio si y solo si la sesión está COMPLETED',
      );
    }
    if (props.transitions.at(-1)?.to !== props.status) {
      throw new InvalidValueError(
        'transitions',
        'la última transición debe llevar al estado actual',
      );
    }
    return new ChargingSession(props);
  }

  get isActive(): boolean {
    return this.status === 'ACTIVE';
  }

  hasSameTerms(terms: SessionTerms): boolean {
    return (
      this.terms.sagaId === terms.sagaId &&
      this.terms.stationId === terms.stationId &&
      this.terms.connectorId === terms.connectorId &&
      this.terms.requestedEnergy.equals(terms.requestedEnergy)
    );
  }

  /** Compensación de la SAGA (idempotente): detiene la carga si sigue activa. */
  abort(now: Date): { session: ChargingSession; outcome: AbortOutcome } {
    switch (this.status) {
      case 'ACTIVE':
        return { session: this.end('ABORTED', now, {}), outcome: 'ABORTED' };
      case 'ABORTED':
        return { session: this, outcome: 'ALREADY_ABORTED' };
      case 'FAILED':
        return { session: this, outcome: 'ALREADY_FAILED' };
      case 'COMPLETED':
        throw new SessionAlreadyCompletedError(`La sesión ${this.id} ya terminó`);
    }
  }

  /** Parada normal (idempotente): ACTIVE → COMPLETED. */
  stop(reason: StopReason, now: Date): { session: ChargingSession; outcome: StopOutcome } {
    if (this.status === 'COMPLETED') {
      return { session: this, outcome: 'ALREADY_STOPPED' };
    }
    if (this.status !== 'ACTIVE') {
      throw new SessionNotActiveError(`La sesión ${this.id} está ${this.status}`);
    }
    return { session: this.end('COMPLETED', now, { stopReason: reason }), outcome: 'STOPPED' };
  }

  /**
   * Registra una lectura: solo en sesiones ACTIVE, no antes del inicio, sin
   * superar la energía solicitada y posterior a la última lectura.
   */
  recordTelemetry(reading: TelemetryReading): {
    session: ChargingSession;
    record: TelemetryRecord;
  } {
    if (this.status !== 'ACTIVE') {
      throw new SessionNotActiveError(`La sesión ${this.id} no acepta telemetría (${this.status})`);
    }
    if (reading.timestamp.getTime() < this.startedAt.getTime()) {
      throw new InvalidValueError('timestamp', 'anterior al inicio de la sesión');
    }
    if (reading.energyKwh * 1000 > this.terms.requestedEnergy.wattHours) {
      throw new InvalidValueError('energyKwh', 'supera la energía solicitada');
    }
    const record = TelemetryRecord.create(this.id, reading);
    record.assertFollows(this.lastTelemetry);
    const session = new ChargingSession({
      ...this.props(),
      lastTelemetry: { timestamp: record.timestamp, energyKwh: record.energyKwh },
      updatedAt: record.timestamp,
    });
    return { session, record };
  }

  private end(
    status: 'ABORTED' | 'COMPLETED',
    now: Date,
    extra: { stopReason?: StopReason },
  ): ChargingSession {
    return new ChargingSession({
      ...this.props(),
      status,
      ...extra,
      transitions: [
        ...this.transitions,
        {
          from: this.status,
          to: status,
          at: now,
          ...(extra.stopReason === undefined ? {} : { reason: extra.stopReason }),
        },
      ],
      endedAt: now,
      updatedAt: now,
    });
  }

  private props(): ChargingSessionProps {
    return {
      id: this.id,
      terms: this.terms,
      status: this.status,
      transitions: this.transitions,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      ...(this.fault === undefined ? {} : { fault: this.fault }),
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      ...(this.lastTelemetry === undefined ? {} : { lastTelemetry: this.lastTelemetry }),
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
    };
  }
}

/** Tombstone: se abortó un id de sesión que nunca llegó a activarse (ADR-0005). */
export class SessionTombstone {
  readonly id: SessionId;
  readonly voidedAt: Date;

  private constructor(id: SessionId, voidedAt: Date) {
    this.id = id;
    this.voidedAt = voidedAt;
  }

  static create(id: SessionId, now: Date): SessionTombstone {
    return new SessionTombstone(id, now);
  }
}

/**
 * Resultado de pedir al cargador que inicie el flujo eléctrico (lo produce el
 * adaptador). FAULT es una falla FÍSICA del cargador (resultado de negocio); un
 * fallo técnico (sin comunicación, timeout) no es un resultado: es una excepción.
 */
export type ChargerActivationResult =
  { readonly kind: 'ACTIVATED' } | { readonly kind: 'FAULT'; readonly fault: ChargerFault };

export type StartSessionResult =
  | { readonly kind: 'STARTED'; readonly session: ChargingSession }
  | { readonly kind: 'REPLAYED'; readonly session: ChargingSession };

/**
 * Antes de llamar al cargador: tombstone → SESSION_ABORTED; mismo id con otros
 * términos → conflicto; mismo id y términos → devuelve la sesión existente (replay).
 */
export function ensureCanStart(input: {
  sessionId: SessionId;
  terms: SessionTerms;
  existing: ChargingSession | undefined;
  tombstone: SessionTombstone | undefined;
}): ChargingSession | undefined {
  if (input.tombstone !== undefined) {
    throw new SessionAbortedError(`La sesión ${input.sessionId} ya fue abortada`);
  }
  if (input.existing !== undefined && !input.existing.hasSameTerms(input.terms)) {
    throw new SessionTermsMismatchError(
      `La sesión ${input.sessionId} ya existe con otros términos`,
    );
  }
  return input.existing;
}

/** Paso 3 de la SAGA: registra el resultado de la activación (idempotente por `sessionId`). */
export function startSession(input: {
  sessionId: SessionId;
  terms: SessionTerms;
  existing: ChargingSession | undefined;
  tombstone: SessionTombstone | undefined;
  activation: ChargerActivationResult;
  now: Date;
}): StartSessionResult {
  const existing = ensureCanStart(input);
  if (existing !== undefined) {
    return { kind: 'REPLAYED', session: existing };
  }
  const session =
    input.activation.kind === 'ACTIVATED'
      ? ChargingSession.activated(input.sessionId, input.terms, input.now)
      : ChargingSession.failed(input.sessionId, input.terms, input.activation.fault, input.now);
  return { kind: 'STARTED', session };
}

/** Compensación: aborta la sesión; si no existe deja un tombstone. */
export function abortSession(input: {
  sessionId: SessionId;
  session: ChargingSession | undefined;
  now: Date;
}):
  | { readonly outcome: AbortOutcome; readonly session: ChargingSession }
  | { readonly outcome: 'VOIDED'; readonly tombstone: SessionTombstone } {
  if (input.session === undefined) {
    return { outcome: 'VOIDED', tombstone: SessionTombstone.create(input.sessionId, input.now) };
  }
  return input.session.abort(input.now);
}
