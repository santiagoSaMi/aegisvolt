import { fleetPolicy, type Principal } from '../authorization.ts';
import { NotFoundError, OperationConflictError } from '../errors.ts';
import type { ReservationView, SagaView, SessionView, Upstreams } from '../ports/upstreams.ts';

export interface ReserveAndActivateChargingInput {
  /** Opcional para operadores (se usa la de su token); obligatoria para administradores. */
  readonly fleetId?: string | undefined;
  readonly stationId: string;
  readonly connectorId: string;
  readonly requestedEnergyKwh: number;
  readonly fastChargeBoost: boolean;
  /** Clave idempotente de la acción del usuario (la genera el cliente, UUID). */
  readonly idempotencyKey: string;
}

/**
 * Caso de uso del BFF que INVOCA la SAGA "Reservar y Activar Carga": autoriza
 * (flota del token) y delega en el orquestador (`POST /v1/sagas` con la
 * `idempotency-key`). No contiene ningún paso ni compensación de la SAGA.
 */
export class ReserveAndActivateCharging {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  execute(
    principal: Principal | undefined,
    input: ReserveAndActivateChargingInput,
  ): Promise<{ saga: SagaView; finished: boolean }> {
    const fleetId = fleetPolicy.resolveFleet(principal, input.fleetId);
    return this.upstreams.orchestrator.startSaga(
      {
        fleetId,
        stationId: input.stationId,
        connectorId: input.connectorId,
        requestedEnergyKwh: input.requestedEnergyKwh,
        fastChargeBoost: input.fastChargeBoost,
      },
      input.idempotencyKey,
    );
  }
}

/**
 * Liberación manual de una reserva (operador de la flota o administrador).
 * Reglas para no interferir con la SAGA dueña:
 * - si la SAGA sigue en curso (no terminal) → CONFLICT `SAGA_IN_PROGRESS`;
 * - si la carga está ACTIVE → CONFLICT `CHARGING_SESSION_ACTIVE` (usar `stopChargingSession`);
 * - en otro caso, `release` idempotente con la SAGA dueña (`x-saga-id`).
 */
export class ReleaseReservation {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  async execute(
    principal: Principal | undefined,
    reservationId: string,
  ): Promise<{ reservation: ReservationView; outcome: string }> {
    const reservation = await this.upstreams.station.getReservation(reservationId);
    if (reservation === undefined) {
      throw new NotFoundError(`No existe la reserva ${reservationId}`);
    }
    fleetPolicy.assertCanAccess(principal, reservation.fleetId);

    const saga = await this.upstreams.orchestrator.getSaga(reservation.sagaId);
    if (saga !== undefined && !saga.terminal) {
      throw new OperationConflictError(
        'SAGA_IN_PROGRESS',
        `La SAGA ${saga.sagaId} sigue en curso (${saga.status}); espere a que termine`,
      );
    }
    if (saga?.status === 'COMPLETED') {
      const session = await this.upstreams.dispatch.getSession(saga.sessionId);
      if (session?.status === 'ACTIVE') {
        throw new OperationConflictError(
          'CHARGING_SESSION_ACTIVE',
          `La carga ${session.sessionId} sigue activa; deténgala con stopChargingSession`,
        );
      }
    }
    const result = await this.upstreams.station.releaseReservation(reservationId, {
      sagaId: reservation.sagaId,
      reason: 'OPERATOR_REQUEST',
    });
    const updated = (await this.upstreams.station.getReservation(reservationId)) ?? reservation;
    return { reservation: updated, outcome: result.outcome };
  }
}

/**
 * Parada de una carga por su flota (o un administrador):
 * 1. la sesión y su SAGA (para saber a qué flota pertenece);
 * 2. parada idempotente del cargador (energy-dispatch);
 * 3. liberación idempotente de la reserva confirmada (el conector vuelve a AVAILABLE).
 * Si el paso 3 falla, reintentar la mutación es seguro: la parada ya hecha
 * responde ALREADY_STOPPED y la liberación se repite.
 */
export class StopChargingSession {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  async execute(
    principal: Principal | undefined,
    sessionId: string,
  ): Promise<{ session: SessionView; outcome: string; reservationOutcome: string | undefined }> {
    const session = await this.upstreams.dispatch.getSession(sessionId);
    if (session === undefined) {
      throw new NotFoundError(`No existe la sesión ${sessionId}`);
    }
    const saga = await this.upstreams.orchestrator.getSaga(session.sagaId);
    if (saga === undefined) {
      // Sin SAGA no se puede determinar la flota: solo un administrador puede pararla.
      if (principal === undefined || !fleetPolicy.isAdmin(principal)) {
        throw new NotFoundError(`No existe la sesión ${sessionId}`);
      }
    } else {
      fleetPolicy.assertCanAccess(principal, saga.fleetId);
    }
    const reason =
      principal !== undefined && fleetPolicy.isAdmin(principal)
        ? 'OPERATOR_REQUEST'
        : 'USER_REQUEST';
    const stopped = await this.upstreams.dispatch.stopSession(sessionId, reason);

    let reservationOutcome: string | undefined;
    if (saga !== undefined) {
      const released = await this.upstreams.station.releaseReservation(saga.reservationId, {
        sagaId: saga.sagaId,
        reason: 'OPERATOR_REQUEST',
      });
      reservationOutcome = released.outcome;
    }
    const updated = (await this.upstreams.dispatch.getSession(sessionId)) ?? session;
    return { session: updated, outcome: stopped.outcome, reservationOutcome };
  }
}
