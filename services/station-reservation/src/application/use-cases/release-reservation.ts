import {
  ReservationId,
  SagaId,
  releaseReservation,
  type ReleaseReason,
  type Reservation,
} from '../../domain/index.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { ReservationRepository } from '../ports/repositories.ts';
import type { Clock } from '../ports/services.ts';

export interface ReleaseReservationCommand {
  readonly reservationId: string;
  /** SAGA que pide liberar (`x-saga-id`): debe ser la dueña de la reserva. */
  readonly sagaId: string;
  readonly reason: ReleaseReason;
}

export type ReleaseReservationResult =
  | { readonly outcome: 'RELEASED' | 'ALREADY_RELEASED'; readonly reservation: Reservation }
  | { readonly outcome: 'VOIDED'; readonly reservationId: ReservationId };

/**
 * Libera una reserva y su conector (compensación de la SAGA). Idempotente:
 * - Valida que la pide la SAGA dueña (RESERVATION_MISMATCH si no).
 * - Solo libera el conector si lo bloquea esta reserva; la escritura está
 *   condicionada a la versión leída, así que nunca libera un bloqueo ajeno.
 * - Si la reserva no existe deja un tombstone (VOIDED).
 */
export class ReleaseReservation {
  private readonly reservations: ReservationRepository;
  private readonly clock: Clock;

  constructor(deps: { reservations: ReservationRepository; clock: Clock }) {
    this.reservations = deps.reservations;
    this.clock = deps.clock;
  }

  execute(command: ReleaseReservationCommand): Promise<ReleaseReservationResult> {
    const reservationId = ReservationId.parse(command.reservationId);
    const requestedBy = SagaId.parse(command.sagaId);
    return withOptimisticRetry(() => this.attempt(reservationId, requestedBy, command.reason));
  }

  private async attempt(
    reservationId: ReservationId,
    requestedBy: SagaId,
    reason: ReleaseReason,
  ): Promise<ReleaseReservationResult> {
    const now = this.clock.now();
    const stored = await this.reservations.findReservation(reservationId);

    if (stored?.kind === 'TOMBSTONE') {
      return { outcome: 'VOIDED', reservationId };
    }
    if (stored === undefined) {
      const result = releaseReservation({
        reservationId,
        reservation: undefined,
        connector: undefined,
        reason,
        requestedBy,
        now,
      });
      if (result.outcome === 'VOIDED') {
        await this.reservations.saveTombstone(result.tombstone);
      }
      return { outcome: 'VOIDED', reservationId };
    }

    const current = stored.reservation;
    const connector = await this.reservations.findConnector(
      current.value.terms.stationId,
      current.value.terms.connectorId,
    );
    const result = releaseReservation({
      reservationId,
      reservation: current.value,
      connector: connector?.value,
      reason,
      requestedBy,
      now,
    });
    if (result.outcome === 'VOIDED') {
      return { outcome: 'VOIDED', reservationId };
    }
    if (result.outcome === 'ALREADY_RELEASED') {
      return { outcome: 'ALREADY_RELEASED', reservation: result.reservation };
    }

    // Solo se escribe el conector si esta reserva lo bloqueaba (release() lo cambió).
    const releasedConnector =
      connector !== undefined &&
      result.connector !== undefined &&
      result.connector !== connector.value
        ? { value: result.connector, expectedVersion: connector.version }
        : undefined;
    await this.reservations.saveTransition({
      reservation: { value: result.reservation, expectedVersion: current.version },
      connector: releasedConnector,
      now,
    });
    return { outcome: 'RELEASED', reservation: result.reservation };
  }
}
