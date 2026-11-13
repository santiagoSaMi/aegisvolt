import type { ConnectorId, SagaId, SessionId, StationId } from '../shared/identifiers.ts';
import { type TelemetryReading, TelemetryRecord } from '../telemetry/telemetry-record.ts';
import {
  SessionAbortedError,
  SessionAlreadyCompletedError,
  SessionNotActiveError,
  SessionTermsMismatchError,
} from './errors.ts';
import type { ChargerFault, RequestedEnergy } from './value-objects.ts';
import { InvalidValueError } from '../shared/domain-error.ts';

export const SESSION_STATUSES = ['ACTIVE', 'FAILED', 'ABORTED', 'COMPLETED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type AbortOutcome = 'ABORTED' | 'ALREADY_ABORTED' | 'ALREADY_FAILED';

/** Términos de la activación: identifican la petición para la idempotencia. */
export interface SessionTerms {
  readonly sagaId: SagaId;
  readonly stationId: StationId;
  readonly connectorId: ConnectorId;
  readonly requestedEnergy: RequestedEnergy;
}

export interface ChargingSessionProps {
  readonly id: SessionId;
  readonly terms: SessionTerms;
  readonly status: SessionStatus;
  readonly fault?: ChargerFault;
  readonly startedAt: Date;
  readonly endedAt?: Date;
  readonly updatedAt: Date;
}

/**
 * Sesión de despacho de energía (paso 3 de la SAGA, pivote). Ciclo de vida:
 *
 *   (activación OK) ACTIVE ──complete──▶ COMPLETED
 *                     └──────abort─────▶ ABORTED
 *   (falla del cargador) FAILED
 *
 * Invariantes: FAILED ⇔ tiene `fault`; los estados terminales tienen `endedAt`.
 */
export class ChargingSession {
  readonly id: SessionId;
  readonly terms: SessionTerms;
  readonly status: SessionStatus;
  readonly fault: ChargerFault | undefined;
  readonly startedAt: Date;
  readonly endedAt: Date | undefined;
  readonly updatedAt: Date;

  private constructor(props: ChargingSessionProps) {
    this.id = props.id;
    this.terms = props.terms;
    this.status = props.status;
    this.fault = props.fault;
    this.startedAt = props.startedAt;
    this.endedAt = props.endedAt;
    this.updatedAt = props.updatedAt;
  }

  static activated(id: SessionId, terms: SessionTerms, now: Date): ChargingSession {
    return new ChargingSession({ id, terms, status: 'ACTIVE', startedAt: now, updatedAt: now });
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
    return new ChargingSession(props);
  }

  hasSameTerms(terms: SessionTerms): boolean {
    return (
      this.terms.sagaId === terms.sagaId &&
      this.terms.stationId === terms.stationId &&
      this.terms.connectorId === terms.connectorId &&
      this.terms.requestedEnergy.equals(terms.requestedEnergy)
    );
  }

  /** Compensación (idempotente): detiene la carga si sigue activa. */
  abort(now: Date): { session: ChargingSession; outcome: AbortOutcome } {
    switch (this.status) {
      case 'ACTIVE':
        return { session: this.end('ABORTED', now), outcome: 'ABORTED' };
      case 'ABORTED':
        return { session: this, outcome: 'ALREADY_ABORTED' };
      case 'FAILED':
        return { session: this, outcome: 'ALREADY_FAILED' };
      case 'COMPLETED':
        throw new SessionAlreadyCompletedError(`La sesión ${this.id} ya terminó`);
    }
  }

  complete(now: Date): ChargingSession {
    if (this.status === 'COMPLETED') {
      return this;
    }
    if (this.status !== 'ACTIVE') {
      throw new SessionNotActiveError(`La sesión ${this.id} está ${this.status}`);
    }
    return this.end('COMPLETED', now);
  }

  /** Registra una lectura: solo en sesiones ACTIVE y no antes del inicio. */
  recordTelemetry(
    reading: TelemetryReading,
    previous: TelemetryRecord | undefined,
  ): TelemetryRecord {
    if (this.status !== 'ACTIVE') {
      throw new SessionNotActiveError(`La sesión ${this.id} no acepta telemetría (${this.status})`);
    }
    if (reading.recordedAt.getTime() < this.startedAt.getTime()) {
      throw new InvalidValueError('recordedAt', 'anterior al inicio de la sesión');
    }
    if (reading.energyDeliveredKwh * 1000 > this.terms.requestedEnergy.wattHours) {
      throw new InvalidValueError('energyDeliveredKwh', 'supera la energía solicitada');
    }
    const record = TelemetryRecord.create(this.id, reading);
    record.assertFollows(previous);
    return record;
  }

  private end(status: 'ABORTED' | 'COMPLETED', now: Date): ChargingSession {
    return new ChargingSession({
      id: this.id,
      terms: this.terms,
      status,
      startedAt: this.startedAt,
      endedAt: now,
      updatedAt: now,
    });
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

/** Resultado de pedir al cargador que inicie el flujo eléctrico (lo produce el adaptador). */
export type ChargerActivationResult =
  { readonly kind: 'ACTIVATED' } | { readonly kind: 'FAULT'; readonly fault: ChargerFault };

export type StartSessionResult =
  | { readonly kind: 'STARTED'; readonly session: ChargingSession }
  | { readonly kind: 'REPLAYED'; readonly session: ChargingSession };

/**
 * Paso 3 de la SAGA (PUT idempotente por `sessionId`). Antes de llamar al
 * cargador, la aplicación usa `ensureCanStart`; después registra el resultado con
 * `startSession`. Una falla produce una sesión FAILED (resultado de negocio, 422).
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
