import {
  ReservationCancelledError,
  ReservationId,
  SagaId,
  confirmReservation,
  type Reservation,
} from '../../domain/index.ts';
import { ConnectorNotFoundError, ReservationNotFoundError } from '../errors.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { ReservationRepository } from '../ports/repositories.ts';
import type { Clock } from '../ports/services.ts';

export interface ConfirmReservationCommand {
  readonly reservationId: string;
  readonly sagaId: string;
}

/**
 * Fin de la SAGA: la carga empezó. Reserva HELD → CONFIRMED y conector
 * RESERVED → OCCUPIED en una transacción. Idempotente.
 */
export class ConfirmReservation {
  private readonly reservations: ReservationRepository;
  private readonly clock: Clock;

  constructor(deps: { reservations: ReservationRepository; clock: Clock }) {
    this.reservations = deps.reservations;
    this.clock = deps.clock;
  }

  execute(command: ConfirmReservationCommand): Promise<{ reservation: Reservation; now: Date }> {
    const reservationId = ReservationId.parse(command.reservationId);
    const requestedBy = SagaId.parse(command.sagaId);
    return withOptimisticRetry(() => this.attempt(reservationId, requestedBy));
  }

  private async attempt(
    reservationId: ReservationId,
    requestedBy: SagaId,
  ): Promise<{ reservation: Reservation; now: Date }> {
    const now = this.clock.now();
    const stored = await this.reservations.findReservation(reservationId);
    if (stored === undefined) {
      throw new ReservationNotFoundError(`No existe la reserva ${reservationId}`);
    }
    if (stored.kind === 'TOMBSTONE') {
      throw new ReservationCancelledError(`La reserva ${reservationId} fue compensada`);
    }
    const current = stored.reservation;
    const connector = await this.reservations.findConnector(
      current.value.terms.stationId,
      current.value.terms.connectorId,
    );
    if (connector === undefined) {
      throw new ConnectorNotFoundError(`No existe el conector de la reserva ${reservationId}`);
    }

    const result = confirmReservation({
      reservation: current.value,
      connector: connector.value,
      requestedBy,
      now,
    });
    if (result.reservation === current.value && result.connector === connector.value) {
      return { reservation: result.reservation, now };
    }
    await this.reservations.saveTransition({
      reservation: { value: result.reservation, expectedVersion: current.version },
      connector:
        result.connector === connector.value
          ? undefined
          : { value: result.connector, expectedVersion: connector.version },
      now,
    });
    return { reservation: result.reservation, now };
  }
}
