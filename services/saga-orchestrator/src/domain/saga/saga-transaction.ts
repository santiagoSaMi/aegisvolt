import { InvalidValueError } from '../shared/domain-error.ts';
import type {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  ReservationId,
  SagaId,
  SessionId,
  StationId,
} from '../shared/identifiers.ts';
import {
  IdempotencyKeyConflictError,
  InvalidSagaTransitionError,
  SagaNotRetryableError,
} from './errors.ts';
import type { RetryPolicy } from './retry-policy.ts';
import {
  isPrePivotStatus,
  isRejectionOf,
  isTerminalStatus,
  type AbandonReason,
  type CompensationStep,
  type FailureReason,
  type ForwardStep,
  type RejectionReason,
  type SagaEventType,
  type SagaStatus,
  type SagaStep,
  type StepStatus,
} from './vocabulary.ts';

export interface SagaRequest {
  readonly fleetId: FleetId;
  readonly stationId: StationId;
  readonly connectorId: ConnectorId;
  readonly requestedEnergyKwh: number;
  readonly fastChargeBoost: boolean;
}

/** Ids pre-generados al crear la SAGA, antes de llamar a ningún servicio (ADR-0005). */
export interface SagaResourceIds {
  readonly reservationId: ReservationId;
  readonly debitId: DebitId;
  readonly sessionId: SessionId;
}

/**
 * Claves idempotentes de los pasos sin id de recurso propio (confirmación y
 * compensaciones). Se generan una vez y se persisten: todo reintento, en
 * cualquier réplica y tras cualquier reinicio, usa la MISMA clave.
 */
export type OperationKeys = Readonly<Record<'CONFIRMATION' | CompensationStep, string>>;

export interface StepState {
  readonly status: StepStatus;
  readonly attempts: number;
  readonly lastErrorCode?: string;
  readonly updatedAt: Date;
}

export type SagaSteps = Readonly<Partial<Record<SagaStep, StepState>>>;

/** Compensación que falló y dejó la SAGA en COMPENSATION_FAILED. */
export interface CompensationFailure {
  readonly step: CompensationStep;
  readonly errorCode: string;
  readonly detail?: string;
  /** Ronda de compensación (cada ronda = intentos inmediatos de un paso). */
  readonly round: number;
  readonly failedAt: Date;
  /** Reintento automático programado; ausente si se agotaron las rondas. */
  readonly nextAttemptAt?: Date;
}

export interface SagaEvent {
  readonly sequence: number;
  readonly type: SagaEventType;
  readonly step?: SagaStep;
  /** Estado de la SAGA tras el evento. */
  readonly status: SagaStatus;
  readonly attempt?: number;
  readonly errorCode?: string;
  readonly occurredAt: Date;
}

export interface SagaTransactionProps {
  readonly id: SagaId;
  readonly idempotencyKey: string;
  readonly request: SagaRequest;
  readonly resources: SagaResourceIds;
  readonly operationKeys: OperationKeys;
  readonly correlationId: CorrelationId;
  readonly status: SagaStatus;
  readonly steps: SagaSteps;
  /** Potencia del conector, obtenida en la reserva y necesaria para el débito. */
  readonly connectorPowerKw?: number;
  readonly failureReason?: FailureReason;
  /** Paso de avance que falló y originó la compensación. */
  readonly failedStep?: ForwardStep;
  /** Compensaciones a ejecutar, en orden (fijado al empezar a compensar). */
  readonly compensationPlan: readonly CompensationStep[];
  readonly compensationFailure?: CompensationFailure;
  readonly compensationRounds: number;
  /** Número de eventos ya persistidos (secuencia del siguiente). */
  readonly eventCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type NewEvent = Omit<SagaEvent, 'sequence' | 'occurredAt' | 'status'>;

interface Changes {
  status?: SagaStatus;
  steps?: SagaSteps;
  connectorPowerKw?: number;
  failureReason?: FailureReason;
  failedStep?: ForwardStep;
  compensationPlan?: readonly CompensationStep[];
  compensationFailure?: CompensationFailure | null;
  compensationRounds?: number;
}

/** Paso de avance pendiente en cada estado de avance. */
const STEP_FOR_STATUS: Partial<Record<SagaStatus, ForwardStep>> = {
  STARTED: 'RESERVATION',
  RESERVATION_COMPLETED: 'DEBIT',
  BILLING_COMPLETED: 'ACTIVATION',
  DISPATCH_COMPLETED: 'CONFIRMATION',
};

/** Estado alcanzado al completar cada paso. */
const STATUS_AFTER: Record<ForwardStep, SagaStatus> = {
  RESERVATION: 'RESERVATION_COMPLETED',
  DEBIT: 'BILLING_COMPLETED',
  ACTIVATION: 'DISPATCH_COMPLETED',
  CONFIRMATION: 'COMPLETED',
};

/**
 * Compensaciones necesarias cuando falla un paso de avance, en orden inverso.
 * - `outcomeKnown`: el servicio RECHAZÓ el paso (sabemos que no tuvo efecto).
 * - Resultado desconocido (reintentos agotados, plazo vencido): también se
 *   compensa el propio paso; las compensaciones son idempotentes y, si el
 *   recurso no existe, dejan un tombstone que bloquea un avance tardío (ADR-0005).
 * - Tras la activación (confirmación fallida) hay una carga en curso: se aborta.
 */
export function compensationPlanFor(
  failedStep: ForwardStep,
  outcomeKnown: boolean,
): readonly CompensationStep[] {
  switch (failedStep) {
    case 'RESERVATION':
      return outcomeKnown ? [] : ['RELEASE_RESERVATION'];
    case 'DEBIT':
      return outcomeKnown ? ['RELEASE_RESERVATION'] : ['REFUND_DEBIT', 'RELEASE_RESERVATION'];
    case 'ACTIVATION':
      return outcomeKnown
        ? ['REFUND_DEBIT', 'RELEASE_RESERVATION']
        : ['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION'];
    case 'CONFIRMATION':
      return ['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION'];
  }
}

/**
 * SAGA "Reservar y Activar Carga" (agregado raíz del orquestador). No es una
 * transacción ACID: cada servicio confirma su paso localmente y, si un paso
 * posterior falla, se ejecutan COMPENSACIONES (operaciones de negocio inversas).
 *
 *   STARTED → RESERVATION_COMPLETED → BILLING_COMPLETED → DISPATCH_COMPLETED → COMPLETED
 *      │ rechazo            │ fallo débito        │ fallo activación   │ fallo confirmación
 *      ▼                    ▼                     ▼                    ▼
 *    FAILED            COMPENSATING ──(todas verificadas)──▶ COMPENSATED
 *                           │  ▲
 *          compensación     ▼  │ reintento (worker con backoff o controlado)
 *          fallida     COMPENSATION_FAILED
 *
 * Cada método valida el estado de origen y devuelve una instancia nueva con los
 * eventos nuevos en `pendingEvents`, que se persisten en la misma transacción.
 */
export class SagaTransaction {
  readonly id: SagaId;
  readonly idempotencyKey: string;
  readonly request: SagaRequest;
  readonly resources: SagaResourceIds;
  readonly operationKeys: OperationKeys;
  readonly correlationId: CorrelationId;
  readonly status: SagaStatus;
  readonly steps: SagaSteps;
  readonly connectorPowerKw: number | undefined;
  readonly failureReason: FailureReason | undefined;
  readonly failedStep: ForwardStep | undefined;
  readonly compensationPlan: readonly CompensationStep[];
  readonly compensationFailure: CompensationFailure | undefined;
  readonly compensationRounds: number;
  readonly eventCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Eventos generados desde la última lectura (aún no persistidos). */
  readonly pendingEvents: readonly SagaEvent[];

  private constructor(props: SagaTransactionProps, pendingEvents: readonly SagaEvent[]) {
    this.id = props.id;
    this.idempotencyKey = props.idempotencyKey;
    this.request = props.request;
    this.resources = props.resources;
    this.operationKeys = props.operationKeys;
    this.correlationId = props.correlationId;
    this.status = props.status;
    this.steps = props.steps;
    this.connectorPowerKw = props.connectorPowerKw;
    this.failureReason = props.failureReason;
    this.failedStep = props.failedStep;
    this.compensationPlan = props.compensationPlan;
    this.compensationFailure = props.compensationFailure;
    this.compensationRounds = props.compensationRounds;
    this.eventCount = props.eventCount;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.pendingEvents = pendingEvents;
  }

  static start(input: {
    id: SagaId;
    idempotencyKey: string;
    request: SagaRequest;
    resources: SagaResourceIds;
    operationKeys: OperationKeys;
    correlationId: CorrelationId;
    now: Date;
  }): SagaTransaction {
    const kwh = input.request.requestedEnergyKwh;
    if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 500) {
      throw new InvalidValueError('requestedEnergyKwh', 'debe ser > 0 y ≤ 500');
    }
    const keys = Object.values(input.operationKeys);
    if (keys.some((key) => key.length === 0) || new Set(keys).size !== keys.length) {
      throw new InvalidValueError('operationKeys', 'deben ser no vacías y distintas');
    }
    const saga = new SagaTransaction(
      {
        ...input,
        status: 'STARTED',
        steps: {},
        compensationPlan: [],
        compensationRounds: 0,
        eventCount: 0,
        createdAt: input.now,
        updatedAt: input.now,
      },
      [],
    );
    return saga.next(input.now, {}, [{ type: 'SAGA_STARTED' }]);
  }

  /** Reconstruye desde persistencia validando las invariantes. */
  static restore(props: SagaTransactionProps): SagaTransaction {
    if ((props.status === 'COMPENSATION_FAILED') !== (props.compensationFailure !== undefined)) {
      throw new InvalidValueError(
        'compensationFailure',
        'obligatorio si y solo si la SAGA está COMPENSATION_FAILED',
      );
    }
    if (
      (props.status === 'COMPENSATING' || props.status === 'COMPENSATION_FAILED') &&
      props.compensationPlan.length === 0
    ) {
      throw new InvalidValueError('compensationPlan', 'no puede estar vacío al compensar');
    }
    if (props.status !== 'STARTED' && props.steps.RESERVATION === undefined) {
      throw new InvalidValueError('steps', 'una SAGA avanzada registra su reserva');
    }
    return new SagaTransaction(props, []);
  }

  get isTerminal(): boolean {
    return isTerminalStatus(this.status);
  }

  /** Paso de avance pendiente, si la SAGA está avanzando. */
  get currentStep(): ForwardStep | undefined {
    return STEP_FOR_STATUS[this.status];
  }

  /** Siguiente compensación por verificar, si la SAGA está compensando. */
  get nextCompensation(): CompensationStep | undefined {
    if (this.status !== 'COMPENSATING' && this.status !== 'COMPENSATION_FAILED') {
      return undefined;
    }
    return this.compensationPlan.find((step) => this.steps[step]?.status !== 'SUCCEEDED');
  }

  /** Clave idempotente estable de un paso. */
  idempotencyKeyFor(step: SagaStep): string {
    switch (step) {
      case 'RESERVATION':
        return this.resources.reservationId;
      case 'DEBIT':
        return this.resources.debitId;
      case 'ACTIVATION':
        return this.resources.sessionId;
      default:
        return this.operationKeys[step];
    }
  }

  /** Repetición de la petición inicial: la misma clave exige la misma petición. */
  assertSameRequest(request: SagaRequest): void {
    const a = this.request;
    if (
      a.fleetId !== request.fleetId ||
      a.stationId !== request.stationId ||
      a.connectorId !== request.connectorId ||
      a.requestedEnergyKwh !== request.requestedEnergyKwh ||
      a.fastChargeBoost !== request.fastChargeBoost
    ) {
      throw new IdempotencyKeyConflictError(
        `La clave ${this.idempotencyKey} ya se usó con otra petición`,
      );
    }
  }

  // --- Avance ------------------------------------------------------------------

  /** Intención: se va a llamar al servicio del paso en curso (se persiste ANTES). */
  beginStep(now: Date): SagaTransaction {
    const step = this.requireCurrentStep('beginStep');
    const attempt = this.attemptsOf(step) + 1;
    return this.next(
      now,
      { steps: this.withStep(step, { status: 'IN_PROGRESS', attempts: attempt }, now) },
      [{ type: 'STEP_STARTED', step, attempt }],
    );
  }

  /** El servicio confirmó el paso en curso: avanza al siguiente hito. */
  completeStep(now: Date, result: { connectorPowerKw?: number } = {}): SagaTransaction {
    const step = this.requireInProgress('completeStep');
    if (step === 'RESERVATION' && result.connectorPowerKw === undefined) {
      throw new InvalidValueError('connectorPowerKw', 'la reserva debe registrar la potencia');
    }
    const status = STATUS_AFTER[step];
    const events: NewEvent[] = [{ type: 'STEP_SUCCEEDED', step }];
    if (status === 'COMPLETED') {
      events.push({ type: 'SAGA_COMPLETED' });
    }
    return this.next(
      now,
      {
        status,
        steps: this.withStep(step, { status: 'SUCCEEDED', attempts: this.attemptsOf(step) }, now),
        ...(result.connectorPowerKw === undefined
          ? {}
          : { connectorPowerKw: result.connectorPowerKw }),
      },
      events,
    );
  }

  /** Intento fallido por un error transitorio: el paso queda pendiente de reintento. */
  recordStepAttemptFailure(errorCode: string, now: Date): SagaTransaction {
    const step = this.requireInProgress('recordStepAttemptFailure');
    return this.next(
      now,
      {
        steps: this.withStep(
          step,
          { status: 'PENDING', attempts: this.attemptsOf(step), lastErrorCode: errorCode },
          now,
        ),
      },
      [{ type: 'STEP_FAILED', step, attempt: this.attemptsOf(step), errorCode }],
    );
  }

  /**
   * Rechazo definitivo del paso en curso (el servicio respondió que NO lo hizo).
   * `errorCode` es el código real del servicio; `reason`, su clasificación.
   */
  rejectStep(reason: RejectionReason, errorCode: string, now: Date): SagaTransaction {
    const step = this.requireCurrentStep('rejectStep');
    if (!isRejectionOf(step, reason)) {
      throw new InvalidSagaTransitionError(
        `${String(reason)} no es un rechazo válido del paso ${step}`,
      );
    }
    return this.fail(step, reason, errorCode, compensationPlanFor(step, true), now);
  }

  /** Abandono técnico del paso en curso: su resultado es desconocido, también se compensa. */
  abandonStep(reason: AbandonReason, now: Date): SagaTransaction {
    const step = this.requireCurrentStep('abandonStep');
    return this.fail(step, reason, reason, compensationPlanFor(step, false), now);
  }

  // --- Compensación -----------------------------------------------------------

  /** Intención: se va a ejecutar la siguiente compensación (se persiste ANTES). */
  beginCompensation(now: Date): SagaTransaction {
    this.assertStatus(['COMPENSATING'], 'beginCompensation');
    const step = this.requireNextCompensation();
    const attempt = this.attemptsOf(step) + 1;
    return this.next(
      now,
      { steps: this.withStep(step, { status: 'IN_PROGRESS', attempts: attempt }, now) },
      [{ type: 'COMPENSATION_STEP_STARTED', step, attempt }],
    );
  }

  /**
   * El servicio CONFIRMÓ la compensación (respuesta verificada por el orquestador).
   * Solo cuando todas las del plan están verificadas la SAGA queda COMPENSATED.
   */
  compensationSucceeded(step: CompensationStep, now: Date): SagaTransaction {
    this.assertStatus(['COMPENSATING'], 'compensationSucceeded');
    this.assertCompensationInProgress(step);
    const steps = this.withStep(
      step,
      { status: 'SUCCEEDED', attempts: this.attemptsOf(step) },
      now,
    );
    const events: NewEvent[] = [{ type: 'COMPENSATION_SUCCEEDED', step }];
    const pending = this.compensationPlan.some((s) => steps[s]?.status !== 'SUCCEEDED');
    if (pending) {
      return this.next(now, { steps }, events);
    }
    // Si falló la reserva no hubo efectos confirmados: la liberación fue preventiva.
    const status: SagaStatus = this.failedStep === 'RESERVATION' ? 'FAILED' : 'COMPENSATED';
    events.push({ type: status === 'FAILED' ? 'SAGA_FAILED' : 'SAGA_COMPENSATED' });
    return this.next(now, { status, steps }, events);
  }

  /** Intento inmediato fallido de una compensación (transitorio): se reintentará. */
  recordCompensationAttemptFailure(errorCode: string, now: Date): SagaTransaction {
    this.assertStatus(['COMPENSATING'], 'recordCompensationAttemptFailure');
    const step = this.requireNextCompensation();
    this.assertCompensationInProgress(step);
    return this.next(
      now,
      {
        steps: this.withStep(
          step,
          { status: 'PENDING', attempts: this.attemptsOf(step), lastErrorCode: errorCode },
          now,
        ),
      },
      [{ type: 'COMPENSATION_STEP_FAILED', step, attempt: this.attemptsOf(step), errorCode }],
    );
  }

  /**
   * La compensación falló (intentos inmediatos agotados o respuesta no verificable):
   * COMPENSATION_FAILED con el paso y el error. Si el error es transitorio y
   * quedan rondas se programa un reintento con backoff; si no es recuperable
   * (p. ej. un 409 de negocio) o se agotaron las rondas, solo un reintento
   * CONTROLADO puede retomarla: nunca se reintenta indefinidamente.
   */
  compensationFailed(
    step: CompensationStep,
    failure: { errorCode: string; detail?: string; retryable: boolean },
    now: Date,
    policy: RetryPolicy,
    random: () => number,
  ): SagaTransaction {
    this.assertStatus(['COMPENSATING'], 'compensationFailed');
    if (this.nextCompensation !== step) {
      throw new InvalidSagaTransitionError(`La compensación pendiente no es ${step}`);
    }
    const round = this.compensationRounds + 1;
    const nextAttemptAt =
      failure.retryable && policy.canRetry(round)
        ? new Date(now.getTime() + policy.delayAfter(round, random))
        : undefined;
    return this.next(
      now,
      {
        status: 'COMPENSATION_FAILED',
        steps: this.withStep(
          step,
          {
            status: 'FAILED',
            attempts: this.attemptsOf(step),
            lastErrorCode: failure.errorCode,
          },
          now,
        ),
        compensationRounds: round,
        compensationFailure: {
          step,
          errorCode: failure.errorCode,
          round,
          failedAt: now,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
          ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
        },
      },
      [{ type: 'SAGA_COMPENSATION_FAILED', step, errorCode: failure.errorCode }],
    );
  }

  /**
   * Retoma una SAGA en COMPENSATION_FAILED.
   * - automático (worker): solo cuando vence `nextAttemptAt`;
   * - controlado (operador): en cualquier momento, incluso con las rondas agotadas.
   * Las compensaciones ya verificadas NO se repiten; se sigue por la que falló.
   */
  retryCompensation(now: Date, mode: 'AUTOMATIC' | 'MANUAL'): SagaTransaction {
    if (this.status !== 'COMPENSATION_FAILED') {
      throw new SagaNotRetryableError(
        `La SAGA ${this.id} está ${this.status}: solo se reintenta en COMPENSATION_FAILED`,
      );
    }
    const due = this.compensationFailure?.nextAttemptAt;
    if (mode === 'AUTOMATIC' && (due === undefined || due.getTime() > now.getTime())) {
      throw new SagaNotRetryableError(`La SAGA ${this.id} no tiene un reintento vencido`);
    }
    const step = this.requireNextCompensation();
    return this.next(
      now,
      {
        status: 'COMPENSATING',
        compensationFailure: null,
        // El paso que falló vuelve a estar pendiente. `attempts` cuenta los intentos
        // de la ronda actual (el historial completo queda en los eventos).
        steps: this.withStep(
          step,
          { status: 'PENDING', attempts: 0, ...this.lastErrorOf(step) },
          now,
        ),
        ...(mode === 'MANUAL' ? { compensationRounds: 0 } : {}),
      },
      [{ type: 'COMPENSATION_RETRY_REQUESTED', step, errorCode: mode }],
    );
  }

  /** Copia sin eventos pendientes (tras persistirlos). */
  withoutPendingEvents(): SagaTransaction {
    return new SagaTransaction(this.props(), []);
  }

  // --- Recuperación -----------------------------------------------------------

  /** Otro proceso retomó la SAGA (p. ej. tras un reinicio). */
  markRecovered(now: Date): SagaTransaction {
    if (this.isTerminal) {
      throw new InvalidSagaTransitionError(`La SAGA ${this.id} ya terminó (${this.status})`);
    }
    return this.next(now, {}, [{ type: 'RECOVERED' }]);
  }

  /** ¿Debe retomarla la recuperación? (sin actividad reciente o reintento vencido). */
  isDueForRecovery(now: Date, staleAfterMs: number): boolean {
    if (this.isTerminal) {
      return false;
    }
    if (this.status === 'COMPENSATION_FAILED') {
      const due = this.compensationFailure?.nextAttemptAt;
      return due !== undefined && due.getTime() <= now.getTime();
    }
    return now.getTime() - this.updatedAt.getTime() >= staleAfterMs;
  }

  /**
   * ¿Superó el plazo para seguir avanzando? Antes del pivote, una SAGA retomada
   * tarde se compensa en vez de activar una carga que el usuario ya no espera
   * (y antes de que venza el *hold* de la reserva).
   */
  exceedsForwardDeadline(now: Date, deadlineMs: number): boolean {
    return isPrePivotStatus(this.status) && now.getTime() - this.createdAt.getTime() > deadlineMs;
  }

  // --- Internos ---------------------------------------------------------------

  private fail(
    step: ForwardStep,
    reason: FailureReason,
    errorCode: string,
    plan: readonly CompensationStep[],
    now: Date,
  ): SagaTransaction {
    const steps = this.withStep(
      step,
      { status: 'FAILED', attempts: this.attemptsOf(step), lastErrorCode: errorCode },
      now,
    );
    const events: NewEvent[] = [{ type: 'STEP_FAILED', step, errorCode }];
    if (plan.length === 0) {
      events.push({ type: 'SAGA_FAILED', errorCode: reason });
      return this.next(
        now,
        { status: 'FAILED', steps, failureReason: reason, failedStep: step },
        events,
      );
    }
    // Las compensaciones del plan arrancan pendientes con su clave estable.
    let planned = steps;
    for (const compensation of plan) {
      planned = { ...planned, [compensation]: { status: 'PENDING', attempts: 0, updatedAt: now } };
    }
    events.push({ type: 'COMPENSATION_STARTED', errorCode: reason });
    return this.next(
      now,
      {
        status: 'COMPENSATING',
        steps: planned,
        failureReason: reason,
        failedStep: step,
        compensationPlan: plan,
      },
      events,
    );
  }

  private attemptsOf(step: SagaStep): number {
    return this.steps[step]?.attempts ?? 0;
  }

  private lastErrorOf(step: SagaStep): { lastErrorCode?: string } {
    const code = this.steps[step]?.lastErrorCode;
    return code === undefined ? {} : { lastErrorCode: code };
  }

  private withStep(step: SagaStep, state: Omit<StepState, 'updatedAt'>, now: Date): SagaSteps {
    return { ...this.steps, [step]: { ...state, updatedAt: now } };
  }

  private requireCurrentStep(action: string): ForwardStep {
    const step = this.currentStep;
    if (step === undefined) {
      throw new InvalidSagaTransitionError(`${action} no es válido en estado ${this.status}`);
    }
    return step;
  }

  /**
   * El paso en curso debe haberse intentado: IN_PROGRESS, o PENDING tras un
   * intento fallido cuyo resultado se resolvió después (p. ej. consultando la sesión).
   */
  private requireInProgress(action: string): ForwardStep {
    const step = this.requireCurrentStep(action);
    const state = this.steps[step];
    const attempted =
      state?.status === 'IN_PROGRESS' || (state?.status === 'PENDING' && state.attempts > 0);
    if (!attempted) {
      throw new InvalidSagaTransitionError(`${action}: el paso ${step} no se ha intentado`);
    }
    return step;
  }

  private requireNextCompensation(): CompensationStep {
    const step = this.nextCompensation;
    if (step === undefined) {
      throw new InvalidSagaTransitionError(`La SAGA ${this.id} no tiene compensaciones pendientes`);
    }
    return step;
  }

  private assertCompensationInProgress(step: CompensationStep): void {
    if (this.nextCompensation !== step || this.steps[step]?.status !== 'IN_PROGRESS') {
      throw new InvalidSagaTransitionError(`La compensación ${step} no está en curso`);
    }
  }

  private assertStatus(allowed: readonly SagaStatus[], action: string): void {
    if (!allowed.includes(this.status)) {
      throw new InvalidSagaTransitionError(`${action} no es válido en estado ${this.status}`);
    }
  }

  private props(): SagaTransactionProps {
    return {
      id: this.id,
      idempotencyKey: this.idempotencyKey,
      request: this.request,
      resources: this.resources,
      operationKeys: this.operationKeys,
      correlationId: this.correlationId,
      status: this.status,
      steps: this.steps,
      compensationPlan: this.compensationPlan,
      compensationRounds: this.compensationRounds,
      eventCount: this.eventCount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.connectorPowerKw === undefined ? {} : { connectorPowerKw: this.connectorPowerKw }),
      ...(this.failureReason === undefined ? {} : { failureReason: this.failureReason }),
      ...(this.failedStep === undefined ? {} : { failedStep: this.failedStep }),
      ...(this.compensationFailure === undefined
        ? {}
        : { compensationFailure: this.compensationFailure }),
    };
  }

  private next(now: Date, changes: Changes, newEvents: readonly NewEvent[]): SagaTransaction {
    const { compensationFailure, ...rest } = changes;
    const { compensationFailure: current, ...base } = this.props();
    const failure = compensationFailure === null ? undefined : (compensationFailure ?? current);
    const props: SagaTransactionProps = {
      ...base,
      ...rest,
      eventCount: base.eventCount + newEvents.length,
      updatedAt: now,
      ...(failure === undefined ? {} : { compensationFailure: failure }),
    };
    const status = props.status;
    const events = newEvents.map((event, index) => ({
      ...event,
      sequence: base.eventCount + index,
      status,
      occurredAt: now,
    }));
    return new SagaTransaction(props, [...this.pendingEvents, ...events]);
  }
}
