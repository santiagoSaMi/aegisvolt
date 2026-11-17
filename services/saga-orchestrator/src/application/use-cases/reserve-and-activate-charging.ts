import {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  ReservationId,
  SagaId,
  SagaTransaction,
  SessionId,
  StationId,
  type SagaRequest,
} from '../../domain/index.ts';
import { ConcurrentModificationError, SagaAlreadyExistsError } from '../errors.ts';
import type { SagaRepository, Versioned } from '../ports/repositories.ts';
import type { Clock, IdGenerator, SagaObserver } from '../ports/services.ts';
import type { SagaExecutor } from '../saga-executor.ts';

export interface ReserveAndActivateChargingCommand {
  /** Clave idempotente de la acción del usuario (UUID). */
  readonly idempotencyKey: string;
  /** `correlation_id` de la petición; queda fijado en la SAGA para siempre. */
  readonly correlationId: string;
  readonly fleetId: string;
  readonly stationId: string;
  readonly connectorId: string;
  readonly requestedEnergyKwh: number;
  readonly fastChargeBoost: boolean;
}

export interface ReserveAndActivateChargingResult {
  readonly saga: SagaTransaction;
  /** false: la clave ya existía (repetición de la petición inicial). */
  readonly created: boolean;
}

/**
 * Caso de uso "Reservar y Activar Carga" (SAGA orquestada, ADR-0003/0024).
 *
 * 1. Crea y PERSISTE la SAGA (STARTED) con `saga_id`, `correlation_id`, ids de
 *    recursos y claves idempotentes de cada compensación, ANTES de llamar a nadie.
 * 2. La ejecuta con su *lease*: reserva → débito → activación → confirmación.
 *
 * Idempotencia de la petición inicial: el id se deriva de la clave
 * (`saga_<clave>`). Repetirla devuelve la misma SAGA; si quedó a medias y nadie
 * la ejecuta (*lease* libre), la reanuda. Nunca crea una segunda SAGA.
 */
export class ReserveAndActivateCharging {
  private readonly sagas: SagaRepository;
  private readonly executor: SagaExecutor;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly observer: SagaObserver;

  constructor(deps: {
    sagas: SagaRepository;
    executor: SagaExecutor;
    clock: Clock;
    ids: IdGenerator;
    observer: SagaObserver;
  }) {
    this.sagas = deps.sagas;
    this.executor = deps.executor;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.observer = deps.observer;
  }

  async execute(
    command: ReserveAndActivateChargingCommand,
  ): Promise<ReserveAndActivateChargingResult> {
    const key = command.idempotencyKey.toLowerCase();
    const sagaId = SagaId.parse(`saga_${key}`);
    const request: SagaRequest = {
      fleetId: FleetId.parse(command.fleetId),
      stationId: StationId.parse(command.stationId),
      connectorId: ConnectorId.parse(command.connectorId),
      requestedEnergyKwh: command.requestedEnergyKwh,
      fastChargeBoost: command.fastChargeBoost,
    };

    const existing = await this.sagas.find(sagaId);
    if (existing !== undefined) {
      return { saga: await this.replay(existing, request), created: false };
    }

    const saga = SagaTransaction.start({
      id: sagaId,
      idempotencyKey: key,
      request,
      resources: {
        reservationId: ReservationId.parse(`res_${key}`),
        debitId: DebitId.parse(`dbt_${key}`),
        sessionId: SessionId.parse(`ses_${key}`),
      },
      operationKeys: {
        CONFIRMATION: this.ids.uuid(),
        ABORT_SESSION: this.ids.uuid(),
        REFUND_DEBIT: this.ids.uuid(),
        RELEASE_RESERVATION: this.ids.uuid(),
      },
      correlationId: CorrelationId.parse(command.correlationId.toLowerCase()),
      now: this.clock.now(),
    });
    try {
      await this.sagas.create(saga, this.executor.lease());
    } catch (error) {
      if (!(error instanceof SagaAlreadyExistsError)) {
        throw error;
      }
      // Dos peticiones simultáneas con la misma clave: la otra la creó.
      const winner = await this.sagas.find(sagaId);
      if (winner === undefined) {
        throw error;
      }
      return { saga: await this.replay(winner, request), created: false };
    }
    this.observer.transitioned(saga, saga.pendingEvents);
    const final = await this.runOwned({ value: saga.withoutPendingEvents(), version: 1 });
    return { saga: final, created: true };
  }

  /** Repetición: misma petición obligatoria; si la SAGA quedó a medias y está libre, se reanuda. */
  private async replay(
    stored: Versioned<SagaTransaction>,
    request: SagaRequest,
  ): Promise<SagaTransaction> {
    stored.value.assertSameRequest(request);
    if (stored.value.isTerminal || stored.value.status === 'COMPENSATION_FAILED') {
      return stored.value;
    }
    const acquired = await this.sagas.acquireLease(
      stored.value.id,
      this.executor.lease(),
      this.clock.now(),
    );
    if (!acquired) {
      // Otra réplica (o la petición original) la está ejecutando.
      return stored.value;
    }
    const fresh = await this.sagas.find(stored.value.id);
    if (fresh === undefined || fresh.value.isTerminal) {
      await this.sagas.releaseLease(stored.value.id, this.executor.lease().owner);
      return fresh?.value ?? stored.value;
    }
    const recovered = await this.executor.persist(
      fresh,
      fresh.value.markRecovered(this.clock.now()),
    );
    return this.runOwned(recovered);
  }

  /** Ejecuta con el *lease* tomado y lo libera al terminar (o al perderlo). */
  private async runOwned(start: Versioned<SagaTransaction>): Promise<SagaTransaction> {
    try {
      const final = await this.executor.run(start);
      await this.sagas.releaseLease(final.value.id, this.executor.lease().owner);
      return final.value;
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        // Otra réplica tomó la SAGA: se devuelve lo que haya persistido.
        const latest = await this.sagas.find(start.value.id);
        return latest?.value ?? start.value;
      }
      throw error;
    }
  }
}
