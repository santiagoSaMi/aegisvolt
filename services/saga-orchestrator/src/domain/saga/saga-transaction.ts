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
import { InvalidSagaTransitionError } from './errors.ts';
import type { RetryPolicy } from './retry-policy.ts';
import {
  BUSINESS_REJECTIONS,
  isForwardStatus,
  isTerminalStatus,
  type AbandonReason,
  type BusinessRejection,
  type CompensationStep,
  type FailureReason,
  type ForwardStep,
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

export interface StepState {
  readonly status: StepStatus;
  readonly attempts: number;
  readonly lastErrorCode?: string;
  readonly updatedAt: Date;
}

export interface SagaEvent {
  readonly sequence: number;
  readonly type: SagaEventType;
  readonly step?: SagaStep;
  readonly occurredAt: Date;
  readonly errorCode?: string;
}

export type SagaSteps = Readonly<Partial<Record<SagaStep, StepState>>>;

export interface SagaTransactionProps {
  readonly id: SagaId;
  readonly request: SagaRequest;
  readonly resources: SagaResourceIds;
  readonly correlationId: CorrelationId;
  readonly status: SagaStatus;
  readonly steps: SagaSteps;
  readonly failureReason?: FailureReason;
  /** Paso de avance que falló y originó la compensación. */
  readonly failedStep?: ForwardStep;
  /** Compensaciones a ejecutar, en orden (fijado al empezar a compensar). */
  readonly compensationPlan: readonly CompensationStep[];
  readonly nextAttemptAt?: Date;
  readonly events: readonly SagaEvent[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type NewEvent = Omit<SagaEvent, 'sequence' | 'occurredAt'>;

interface StateChanges {
  status?: SagaStatus;
  steps?: SagaSteps;
  failureReason?: FailureReason;
  failedStep?: ForwardStep;
  compensationPlan?: readonly CompensationStep[];
  nextAttemptAt?: Date | null;
}

const STEP_BY_STATUS: Partial<Record<SagaStatus, ForwardStep>> = {
  RESERVING: 'RESERVATION',
  DEBITING: 'DEBIT',
  ACTIVATING: 'ACTIVATION',
  CONFIRMING: 'CONFIRMATION',
};

const NEXT_AFTER: Record<ForwardStep, { status: SagaStatus; step?: ForwardStep }> = {
  RESERVATION: { status: 'DEBITING', step: 'DEBIT' },
  DEBIT: { status: 'ACTIVATING', step: 'ACTIVATION' },
  ACTIVATION: { status: 'CONFIRMING', step: 'CONFIRMATION' },
  CONFIRMATION: { status: 'COMPLETED' },
};

/**
 * Compensaciones necesarias cuando falla un paso de avance.
 * - `outcomeKnown`: el servicio rechazó el paso (sabemos que NO tuvo efecto).
 * - Si el resultado es desconocido (reintentos agotados, timeout), también se
 *   compensa el propio paso: las compensaciones son idempotentes y, si el recurso
 *   no existe, dejan un tombstone (ADR-0005).
 * La activación siempre incluye `abort`: el cargador pudo activarse aunque la
 * respuesta se perdiera (P-09).
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
      return ['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION'];
    case 'CONFIRMATION':
      return [];
  }
}

/**
 * SAGA "Reservar y Activar Carga" (agregado raíz del orquestador).
 *
 * Máquina de estados persistente: cada método valida el estado de origen,
 * devuelve una instancia nueva y añade eventos al historial (`events`), que la
 * persistencia guarda en la misma transacción que el estado.
 *
 *   STARTED → RESERVING → DEBITING → ACTIVATING → CONFIRMING → COMPLETED
 *                 │            │            │
 *                 │ rechazo    │ rechazo /  │ falla / abandono
 *                 ▼            ▼ abandono   ▼
 *              FAILED       COMPENSATING ⇄ COMPENSATION_PENDING
 *                              │                 │ reintentos agotados
 *                              ▼                 ▼
 *                    COMPENSATED / FAILED   REQUIRES_ATTENTION
 */
export class SagaTransaction {
  readonly id: SagaId;
  readonly request: SagaRequest;
  readonly resources: SagaResourceIds;
  readonly correlationId: CorrelationId;
  readonly status: SagaStatus;
  readonly steps: SagaSteps;
  readonly failureReason: FailureReason | undefined;
  readonly failedStep: ForwardStep | undefined;
  readonly compensationPlan: readonly CompensationStep[];
  readonly nextAttemptAt: Date | undefined;
  readonly events: readonly SagaEvent[];
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: SagaTransactionProps) {
    this.id = props.id;
    this.request = props.request;
    this.resources = props.resources;
    this.correlationId = props.correlationId;
    this.status = props.status;
    this.steps = props.steps;
    this.failureReason = props.failureReason;
    this.failedStep = props.failedStep;
    this.compensationPlan = props.compensationPlan;
    this.nextAttemptAt = props.nextAttemptAt;
    this.events = props.events;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static start(input: {
    id: SagaId;
    request: SagaRequest;
    resources: SagaResourceIds;
    correlationId: CorrelationId;
    now: Date;
  }): SagaTransaction {
    const kwh = input.request.requestedEnergyKwh;
    if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 500) {
      throw new InvalidValueError('requestedEnergyKwh', 'debe ser > 0 y ≤ 500');
    }
    return new SagaTransaction({
      id: input.id,
      request: input.request,
      resources: input.resources,
      correlationId: input.correlationId,
      status: 'STARTED',
      steps: {},
      compensationPlan: [],
      events: [{ sequence: 0, type: 'SAGA_STARTED', occurredAt: input.now }],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Reconstruye desde persistencia validando las invariantes. */
  static restore(props: SagaTransactionProps): SagaTransaction {
    if (isTerminalStatus(props.status) && props.nextAttemptAt !== undefined) {
      throw new InvalidValueError('nextAttemptAt', 'una SAGA terminal no programa reintentos');
    }
    if (props.status === 'COMPENSATION_PENDING' && props.nextAttemptAt === undefined) {
      throw new InvalidValueError('nextAttemptAt', 'obligatorio en COMPENSATION_PENDING');
    }
    if (
      (props.status === 'COMPENSATING' || props.status === 'COMPENSATION_PENDING') &&
      props.compensationPlan.length === 0
    ) {
      throw new InvalidValueError('compensationPlan', 'no puede estar vacío al compensar');
    }
    return new SagaTransaction(props);
  }

  get isTerminal(): boolean {
    return isTerminalStatus(this.status);
  }

  /** Paso de avance en curso, si la SAGA está avanzando. */
  get currentStep(): ForwardStep | undefined {
    return STEP_BY_STATUS[this.status];
  }

  /** Siguiente compensación pendiente, si la SAGA está compensando. */
  get nextCompensation(): CompensationStep | undefined {
    if (this.status !== 'COMPENSATING' && this.status !== 'COMPENSATION_PENDING') {
      return undefined;
    }
    return this.compensationPlan.find((step) => this.steps[step]?.status !== 'SUCCEEDED');
  }

  // --- Avance ------------------------------------------------------------------

  beginReservation(now: Date): SagaTransaction {
    this.assertStatus(['STARTED'], 'beginReservation');
    return this.next(
      now,
      {
        status: 'RESERVING',
        steps: this.withStep('RESERVATION', { status: 'PENDING', attempts: 0 }, now),
      },
      [{ type: 'STEP_STARTED', step: 'RESERVATION' }],
    );
  }

  /** El paso en curso tuvo éxito: avanza al siguiente o completa la SAGA. */
  completeCurrentStep(now: Date): SagaTransaction {
    const step = this.requireCurrentStep('completeCurrentStep');
    const { status, step: nextStep } = NEXT_AFTER[step];
    let steps = this.withStep(
      step,
      { status: 'SUCCEEDED', attempts: this.attemptsOf(step) + 1 },
      now,
    );
    const events: NewEvent[] = [{ type: 'STEP_SUCCEEDED', step }];

    if (nextStep === undefined) {
      events.push({ type: 'SAGA_COMPLETED' });
    } else {
      steps = { ...steps, [nextStep]: { status: 'PENDING', attempts: 0, updatedAt: now } };
      events.push({ type: 'STEP_STARTED', step: nextStep });
    }
    return this.next(now, { status, steps }, events);
  }

  /** Intento fallido por un error transitorio: el paso sigue pendiente de reintento. */
  recordAttemptFailure(errorCode: string, now: Date): SagaTransaction {
    const step = this.requireCurrentStep('recordAttemptFailure');
    return this.next(
      now,
      {
        steps: this.withStep(
          step,
          { status: 'PENDING', attempts: this.attemptsOf(step) + 1, lastErrorCode: errorCode },
          now,
        ),
      },
      [{ type: 'STEP_FAILED', step, errorCode }],
    );
  }

  /** Rechazo de negocio definitivo del paso en curso (409/403/422 del servicio). */
  rejectCurrentStep(reason: BusinessRejection, now: Date): SagaTransaction {
    const step = this.requireCurrentStep('rejectCurrentStep');
    const allowed: readonly string[] = step === 'CONFIRMATION' ? [] : BUSINESS_REJECTIONS[step];
    if (!allowed.includes(reason)) {
      throw new InvalidSagaTransitionError(`${reason} no es un rechazo válido del paso ${step}`);
    }
    return this.fail(step, reason, compensationPlanFor(step, true), now);
  }

  /**
   * Abandono técnico del paso en curso (reintentos agotados o plazo de
   * recuperación vencido): su resultado es desconocido, así que también se compensa.
   * Tras el pivote (CONFIRMING) no se compensa: requiere atención manual.
   */
  abandonCurrentStep(reason: AbandonReason, now: Date): SagaTransaction {
    if (this.status === 'STARTED') {
      return this.next(now, { status: 'FAILED', failureReason: reason }, [
        { type: 'SAGA_FAILED', errorCode: reason },
      ]);
    }
    const step = this.requireCurrentStep('abandonCurrentStep');
    if (step === 'CONFIRMATION') {
      return this.next(
        now,
        {
          status: 'REQUIRES_ATTENTION',
          failureReason: reason,
          steps: this.withStep(
            step,
            { status: 'FAILED', attempts: this.attemptsOf(step), lastErrorCode: reason },
            now,
          ),
        },
        [
          { type: 'STEP_FAILED', step, errorCode: reason },
          { type: 'SAGA_REQUIRES_ATTENTION', errorCode: reason },
        ],
      );
    }
    return this.fail(step, reason, compensationPlanFor(step, false), now);
  }

  // --- Compensación -----------------------------------------------------------

  compensationSucceeded(step: CompensationStep, now: Date): SagaTransaction {
    this.assertStatus(['COMPENSATING'], 'compensationSucceeded');
    this.assertNextCompensation(step);
    const steps = this.withStep(
      step,
      { status: 'SUCCEEDED', attempts: this.attemptsOf(step) + 1 },
      now,
    );
    const events: NewEvent[] = [{ type: 'COMPENSATION_SUCCEEDED', step }];
    const pending = this.compensationPlan.some(
      (s) => s !== step && steps[s]?.status !== 'SUCCEEDED',
    );

    if (pending) {
      return this.next(now, { steps }, events);
    }
    // Si falló la reserva no hubo efectos confirmados: la SAGA termina FAILED.
    const status = this.failedStep === 'RESERVATION' ? 'FAILED' : 'COMPENSATED';
    events.push({ type: status === 'FAILED' ? 'SAGA_FAILED' : 'SAGA_COMPENSATED' });
    return this.next(now, { status, steps, nextAttemptAt: null }, events);
  }

  /**
   * Una ronda de compensación falló: se reprograma con backoff (COMPENSATION_PENDING)
   * o, si se agotaron las rondas, la SAGA queda en REQUIRES_ATTENTION.
   */
  compensationFailed(
    step: CompensationStep,
    errorCode: string,
    now: Date,
    policy: RetryPolicy,
    random: () => number,
  ): SagaTransaction {
    this.assertStatus(['COMPENSATING'], 'compensationFailed');
    this.assertNextCompensation(step);
    const attempts = this.attemptsOf(step) + 1;
    const steps = this.withStep(
      step,
      { status: 'FAILED', attempts, lastErrorCode: errorCode },
      now,
    );
    const events: NewEvent[] = [{ type: 'COMPENSATION_FAILED', step, errorCode }];

    if (!policy.canRetry(attempts)) {
      events.push({ type: 'SAGA_REQUIRES_ATTENTION', errorCode });
      return this.next(now, { status: 'REQUIRES_ATTENTION', steps, nextAttemptAt: null }, events);
    }
    const nextAttemptAt = new Date(now.getTime() + policy.delayAfter(attempts, random));
    return this.next(now, { status: 'COMPENSATION_PENDING', steps, nextAttemptAt }, events);
  }

  /** El RecoveryWorker retoma una compensación programada cuando llega su hora. */
  resumeCompensation(now: Date): SagaTransaction {
    this.assertStatus(['COMPENSATION_PENDING'], 'resumeCompensation');
    if (this.nextAttemptAt !== undefined && this.nextAttemptAt.getTime() > now.getTime()) {
      throw new InvalidSagaTransitionError(`La SAGA ${this.id} aún no debe reintentarse`);
    }
    return this.next(now, { status: 'COMPENSATING', nextAttemptAt: null }, []);
  }

  // --- Recuperación -----------------------------------------------------------

  /** Registra que otro proceso retomó la SAGA tras un reinicio (02-saga.md §9). */
  markRecovered(now: Date): SagaTransaction {
    if (this.isTerminal) {
      throw new InvalidSagaTransitionError(`La SAGA ${this.id} ya terminó (${this.status})`);
    }
    return this.next(now, {}, [{ type: 'RECOVERED' }]);
  }

  /** ¿Debe retomarla el RecoveryWorker? (sin actividad reciente o reintento vencido). */
  isDueForRecovery(now: Date, staleAfterMs: number): boolean {
    if (this.isTerminal) {
      return false;
    }
    if (this.status === 'COMPENSATION_PENDING') {
      return this.nextAttemptAt !== undefined && this.nextAttemptAt.getTime() <= now.getTime();
    }
    return now.getTime() - this.updatedAt.getTime() >= staleAfterMs;
  }

  /**
   * ¿Superó el plazo para seguir avanzando? Antes del pivote, una SAGA recuperada
   * tarde se compensa en vez de activar una carga que el usuario ya no espera.
   */
  exceedsForwardDeadline(now: Date, deadlineMs: number): boolean {
    return (
      isForwardStatus(this.status) &&
      this.status !== 'CONFIRMING' &&
      now.getTime() - this.createdAt.getTime() > deadlineMs
    );
  }

  // --- Internos ---------------------------------------------------------------

  private fail(
    step: ForwardStep,
    reason: FailureReason,
    plan: readonly CompensationStep[],
    now: Date,
  ): SagaTransaction {
    const steps = this.withStep(
      step,
      { status: 'FAILED', attempts: this.attemptsOf(step) + 1, lastErrorCode: reason },
      now,
    );
    const events: NewEvent[] = [{ type: 'STEP_FAILED', step, errorCode: reason }];

    if (plan.length === 0) {
      events.push({ type: 'SAGA_FAILED', errorCode: reason });
      return this.next(
        now,
        { status: 'FAILED', steps, failureReason: reason, failedStep: step },
        events,
      );
    }
    events.push({ type: 'COMPENSATION_STARTED', errorCode: reason });
    return this.next(
      now,
      {
        status: 'COMPENSATING',
        steps,
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

  private assertStatus(allowed: readonly SagaStatus[], action: string): void {
    if (!allowed.includes(this.status)) {
      throw new InvalidSagaTransitionError(`${action} no es válido en estado ${this.status}`);
    }
  }

  private assertNextCompensation(step: CompensationStep): void {
    if (this.nextCompensation !== step) {
      throw new InvalidSagaTransitionError(
        `La siguiente compensación es ${this.nextCompensation ?? 'ninguna'}, no ${step}`,
      );
    }
  }

  private next(now: Date, changes: StateChanges, newEvents: readonly NewEvent[]): SagaTransaction {
    const failureReason = changes.failureReason ?? this.failureReason;
    const failedStep = changes.failedStep ?? this.failedStep;
    const nextAttemptAt =
      changes.nextAttemptAt === null ? undefined : (changes.nextAttemptAt ?? this.nextAttemptAt);
    const events = [
      ...this.events,
      ...newEvents.map((event, index) => ({
        ...event,
        sequence: this.events.length + index,
        occurredAt: now,
      })),
    ];
    return new SagaTransaction({
      id: this.id,
      request: this.request,
      resources: this.resources,
      correlationId: this.correlationId,
      status: changes.status ?? this.status,
      steps: changes.steps ?? this.steps,
      compensationPlan: changes.compensationPlan ?? this.compensationPlan,
      events,
      createdAt: this.createdAt,
      updatedAt: now,
      ...(failureReason === undefined ? {} : { failureReason }),
      ...(failedStep === undefined ? {} : { failedStep }),
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    });
  }
}
