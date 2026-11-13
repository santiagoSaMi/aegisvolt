import type {
  CompensationStep,
  ForwardStep,
  RejectionReason,
  SagaTransaction,
} from '../domain/index.ts';
import { isRejectionOf } from '../domain/index.ts';
import { ConcurrentModificationError } from './errors.ts';
import type {
  CallContext,
  CallOutcome,
  CompensationReason,
  SagaParticipants,
} from './ports/participants.ts';
import type { Lease, SagaRepository, Versioned } from './ports/repositories.ts';
import type { Clock, SagaExecutionPolicy, SagaObserver, Sleep } from './ports/services.ts';

/**
 * Resultados de compensación que el orquestador acepta como VERIFICADOS: el
 * servicio dueño del recurso confirma que el efecto ya no existe (o nunca existió
 * y quedó un tombstone). Cualquier otra respuesta NO marca la compensación.
 */
const VERIFIED_OUTCOMES: Record<CompensationStep, readonly string[]> = {
  ABORT_SESSION: ['ABORTED', 'ALREADY_ABORTED', 'ALREADY_FAILED', 'VOIDED'],
  REFUND_DEBIT: ['REFUNDED', 'ALREADY_REFUNDED', 'NOTHING_TO_REFUND', 'VOIDED'],
  RELEASE_RESERVATION: ['RELEASED', 'ALREADY_RELEASED', 'VOIDED'],
};

/** El paso se dio por hecho, se rechazó o el resultado sigue siendo desconocido. */
type StepResult =
  | { readonly kind: 'OK'; readonly connectorPowerKw?: number }
  | { readonly kind: 'REJECTED'; readonly code: string }
  | { readonly kind: 'TRANSIENT'; readonly code: string };

export interface SagaExecutorDeps {
  readonly sagas: SagaRepository;
  readonly participants: SagaParticipants;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly policy: SagaExecutionPolicy;
  readonly observer: SagaObserver;
  /** Identidad de esta réplica (dueño del *lease*). */
  readonly owner: string;
}

/**
 * Motor de la SAGA. Precondición: el llamador tiene el *lease* de la SAGA.
 *
 * - Persiste ANTES de cada llamada (paso IN_PROGRESS, con su clave idempotente) y
 *   DESPUÉS (nuevo hito, rechazo o fallo): tras un reinicio, la SAGA se retoma
 *   desde el último estado persistido repitiendo la misma llamada idempotente.
 * - Reintenta solo errores transitorios, con backoff y un máximo; un rechazo de
 *   negocio es definitivo.
 * - No hay transacción ACID entre servicios: si un paso falla, ejecuta las
 *   compensaciones del plan en orden y solo las marca hechas al verificarlas.
 * - Cada escritura está condicionada a versión + *lease*: si otra réplica tomó la
 *   SAGA, este proceso deja de ejecutarla (`ConcurrentModificationError`).
 */
export class SagaExecutor {
  private readonly deps: SagaExecutorDeps;

  constructor(deps: SagaExecutorDeps) {
    this.deps = deps;
  }

  /** Ejecuta hasta un estado terminal o COMPENSATION_FAILED. */
  async run(start: Versioned<SagaTransaction>): Promise<Versioned<SagaTransaction>> {
    let current = start;
    for (;;) {
      const saga = current.value;
      if (saga.isTerminal || saga.status === 'COMPENSATION_FAILED') {
        return current;
      }
      current =
        saga.status === 'COMPENSATING'
          ? await this.compensateNext(current)
          : await this.advance(current);
    }
  }

  /** Persiste un nuevo estado desde la versión leída (renueva el *lease*). */
  async persist(
    current: Versioned<SagaTransaction>,
    next: SagaTransaction,
  ): Promise<Versioned<SagaTransaction>> {
    const version = await this.deps.sagas.save(next, current.version, this.lease());
    this.deps.observer.transitioned(next, next.pendingEvents);
    return { value: next.withoutPendingEvents(), version };
  }

  lease(): Lease {
    return {
      owner: this.deps.owner,
      expiresAt: new Date(this.deps.clock.now().getTime() + this.deps.policy.leaseMs),
    };
  }

  // --- Avance ------------------------------------------------------------------

  private async advance(current: Versioned<SagaTransaction>): Promise<Versioned<SagaTransaction>> {
    const step = current.value.currentStep;
    if (step === undefined) {
      throw new ConcurrentModificationError(`Estado sin paso de avance: ${current.value.status}`);
    }
    // 1) Intención persistida ANTES de llamar al servicio.
    let state = await this.persist(current, current.value.beginStep(this.now()));
    const result = await this.callForward(step, state.value);

    if (result.kind === 'OK') {
      return this.persist(
        state,
        state.value.completeStep(
          this.now(),
          result.connectorPowerKw === undefined
            ? {}
            : { connectorPowerKw: result.connectorPowerKw },
        ),
      );
    }
    if (result.kind === 'REJECTED') {
      return this.persist(
        state,
        state.value.rejectStep(classify(step, result.code), result.code, this.now()),
      );
    }

    // Transitorio: reintentar con backoff mientras la política lo permita.
    state = await this.persist(
      state,
      state.value.recordStepAttemptFailure(result.code, this.now()),
    );
    const attempts = state.value.steps[step]?.attempts ?? 0;
    if (this.deps.policy.forward.canRetry(attempts)) {
      await this.deps.sleep(this.deps.policy.forward.delayAfter(attempts, this.deps.random));
      return state;
    }
    // Reintentos agotados: en el pivote se consulta el estado real antes de compensar.
    if (step === 'ACTIVATION') {
      const resolved = await this.resolveActivation(state);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return this.persist(state, state.value.abandonStep('STEP_RETRIES_EXHAUSTED', this.now()));
  }

  /**
   * Pivote con resultado desconocido: `GET /sessions/{id}`. ACTIVE → la activación
   * ocurrió (se sigue); FAILED → falla física (se compensa como rechazo). Otro
   * resultado → undefined (se abandona y el plan incluye `abort`, P-09).
   */
  private async resolveActivation(
    state: Versioned<SagaTransaction>,
  ): Promise<Versioned<SagaTransaction> | undefined> {
    const saga = state.value;
    const session = await this.deps.participants.dispatch.getSession(
      saga.resources.sessionId,
      this.context(saga, 'ACTIVATION'),
    );
    if (session.kind !== 'OK') {
      return undefined;
    }
    if (session.value.status === 'ACTIVE') {
      return this.persist(state, saga.completeStep(this.now()));
    }
    if (session.value.status === 'FAILED') {
      return this.persist(
        state,
        saga.rejectStep('CHARGER_HARDWARE_FAULT', 'CHARGER_HARDWARE_FAULT', this.now()),
      );
    }
    return undefined;
  }

  private async callForward(step: ForwardStep, saga: SagaTransaction): Promise<StepResult> {
    const { station, billing, dispatch } = this.deps.participants;
    const { request, resources } = saga;
    const ctx = this.context(saga, step);
    switch (step) {
      case 'RESERVATION': {
        const power = await station.getConnectorPower(
          { stationId: request.stationId, connectorId: request.connectorId },
          ctx,
        );
        if (power.kind !== 'OK') {
          return power;
        }
        const hold = await station.holdReservation(
          {
            reservationId: resources.reservationId,
            sagaId: saga.id,
            fleetId: request.fleetId,
            stationId: request.stationId,
            connectorId: request.connectorId,
            fastChargeBoost: request.fastChargeBoost,
          },
          ctx,
        );
        return hold.kind === 'OK'
          ? expectStatus(hold, ['HELD'], { connectorPowerKw: power.value.maxPowerKw })
          : hold;
      }
      case 'DEBIT': {
        const power = saga.connectorPowerKw;
        if (power === undefined) {
          return { kind: 'REJECTED', code: 'STEP_REJECTED' };
        }
        const debit = await billing.debit(
          {
            debitId: resources.debitId,
            sagaId: saga.id,
            fleetId: request.fleetId,
            energyKwh: request.requestedEnergyKwh,
            connectorPowerKw: power,
          },
          ctx,
        );
        return debit.kind === 'OK' ? expectStatus(debit, ['DEBITED']) : debit;
      }
      case 'ACTIVATION': {
        const session = await dispatch.activateSession(
          {
            sessionId: resources.sessionId,
            sagaId: saga.id,
            stationId: request.stationId,
            connectorId: request.connectorId,
            energyKwh: request.requestedEnergyKwh,
          },
          ctx,
        );
        return session.kind === 'OK' ? expectStatus(session, ['ACTIVE']) : session;
      }
      case 'CONFIRMATION': {
        const confirmed = await station.confirmReservation(resources.reservationId, ctx);
        return confirmed.kind === 'OK' ? expectStatus(confirmed, ['CONFIRMED']) : confirmed;
      }
    }
  }

  // --- Compensación -----------------------------------------------------------

  private async compensateNext(
    current: Versioned<SagaTransaction>,
  ): Promise<Versioned<SagaTransaction>> {
    const step = current.value.nextCompensation;
    if (step === undefined) {
      throw new ConcurrentModificationError('COMPENSATING sin compensaciones pendientes');
    }
    // 1) Intención persistida ANTES de llamar al servicio.
    let state = await this.persist(current, current.value.beginCompensation(this.now()));
    const outcome = await this.callCompensation(step, state.value);

    if (outcome.kind === 'OK') {
      if (VERIFIED_OUTCOMES[step].includes(outcome.value.outcome)) {
        return this.persist(state, state.value.compensationSucceeded(step, this.now()));
      }
      return this.failCompensation(state, step, {
        errorCode: 'UNVERIFIED_COMPENSATION',
        detail: `Resultado ${outcome.value.outcome} (${outcome.value.status}) no verifica ${step}`,
        retryable: false,
      });
    }
    if (outcome.kind === 'REJECTED') {
      // No recuperable por reintento: queda para un reintento controlado.
      return this.failCompensation(state, step, {
        errorCode: outcome.code,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        retryable: false,
      });
    }
    state = await this.persist(
      state,
      state.value.recordCompensationAttemptFailure(outcome.code, this.now()),
    );
    const attempts = state.value.steps[step]?.attempts ?? 0;
    const immediate = this.deps.policy.compensationAttempts;
    if (immediate.canRetry(attempts)) {
      await this.deps.sleep(immediate.delayAfter(attempts, this.deps.random));
      return state;
    }
    // Intentos inmediatos agotados: COMPENSATION_FAILED (reintento automático programado).
    return this.failCompensation(state, step, {
      errorCode: outcome.code,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      retryable: true,
    });
  }

  private failCompensation(
    state: Versioned<SagaTransaction>,
    step: CompensationStep,
    failure: { errorCode: string; detail?: string; retryable: boolean },
  ): Promise<Versioned<SagaTransaction>> {
    return this.persist(
      state,
      state.value.compensationFailed(
        step,
        failure,
        this.now(),
        this.deps.policy.compensationRounds,
        this.deps.random,
      ),
    );
  }

  private callCompensation(
    step: CompensationStep,
    saga: SagaTransaction,
  ): Promise<CallOutcome<{ status: string; outcome: string }>> {
    const { station, billing, dispatch } = this.deps.participants;
    const ctx = this.context(saga, step);
    const reason = compensationReasonFor(saga);
    switch (step) {
      case 'ABORT_SESSION':
        return dispatch.abortSession(saga.resources.sessionId, reason, ctx);
      case 'REFUND_DEBIT':
        return billing.refundDebit(saga.resources.debitId, reason, ctx);
      case 'RELEASE_RESERVATION':
        return station.releaseReservation(saga.resources.reservationId, reason, ctx);
    }
  }

  // --- Internos ---------------------------------------------------------------

  private context(saga: SagaTransaction, step: ForwardStep | CompensationStep): CallContext {
    return {
      sagaId: saga.id,
      correlationId: saga.correlationId,
      idempotencyKey: saga.idempotencyKeyFor(step),
    };
  }

  private now(): Date {
    return this.deps.clock.now();
  }
}

/** Clasifica el código de un rechazo para el paso (desconocido → STEP_REJECTED). */
function classify(step: ForwardStep, code: string): RejectionReason {
  return isRejectionOf(step, code) ? code : 'STEP_REJECTED';
}

/** Una respuesta 2xx con un estado inesperado no confirma el paso. */
function expectStatus(
  outcome: { kind: 'OK'; value: { status: string } },
  expected: readonly string[],
  extra: { connectorPowerKw?: number } = {},
): StepResult {
  return expected.includes(outcome.value.status)
    ? { kind: 'OK', ...extra }
    : { kind: 'REJECTED', code: 'STEP_REJECTED' };
}

/** Motivo de compensación del contrato común según la causa del fallo. */
function compensationReasonFor(saga: SagaTransaction): CompensationReason {
  switch (saga.failureReason) {
    case 'INSUFFICIENT_FUNDS':
    case 'CHARGER_HARDWARE_FAULT':
    case 'RECOVERY_DEADLINE_EXCEEDED':
      return saga.failureReason;
    default:
      return 'FORWARD_STEP_FAILED';
  }
}
