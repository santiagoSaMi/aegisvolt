import { InvalidValueError } from '../shared/domain-error.ts';
import type { ReservationId } from '../shared/identifiers.ts';
import type { ChargingConnector } from '../station/charging-connector.ts';
import { ReservationCancelledError, ReservationTermsMismatchError } from './errors.ts';
import {
  Reservation,
  ReservationTombstone,
  type ReleaseReason,
  type ReservationTerms,
} from './reservation.ts';
import type { ReservationPolicy } from './reservation-policy.ts';

/**
 * Servicios de dominio que coordinan los agregados Reservation y ChargingConnector.
 * Son funciones puras: la aplicación persiste el resultado en una transacción.
 */

export type HoldResult =
  | {
      readonly kind: 'CREATED';
      readonly reservation: Reservation;
      readonly connector: ChargingConnector;
    }
  | { readonly kind: 'REPLAYED'; readonly reservation: Reservation };

/** Paso 1 de la SAGA: bloquea el conector (PUT idempotente por `reservationId`). */
export function holdConnector(input: {
  reservationId: ReservationId;
  terms: ReservationTerms;
  connector: ChargingConnector;
  existing: Reservation | undefined;
  tombstone: ReservationTombstone | undefined;
  policy: ReservationPolicy;
  fastChargeBoostEnabled: boolean;
  now: Date;
}): HoldResult {
  if (input.tombstone !== undefined) {
    throw new ReservationCancelledError(`La reserva ${input.reservationId} ya fue compensada`);
  }
  if (input.existing !== undefined) {
    if (!input.existing.hasSameTerms(input.terms)) {
      throw new ReservationTermsMismatchError(
        `La reserva ${input.reservationId} ya existe con otros términos`,
      );
    }
    return { kind: 'REPLAYED', reservation: input.existing };
  }
  if (
    input.connector.id !== input.terms.connectorId ||
    input.connector.stationId !== input.terms.stationId
  ) {
    throw new InvalidValueError('connectorId', 'el conector no corresponde a la estación indicada');
  }

  const holdDurationMs = input.policy.holdDurationFor({
    connector: input.connector,
    fastChargeBoost: input.terms.fastChargeBoost,
    fastChargeBoostEnabled: input.fastChargeBoostEnabled,
  });
  const reservation = Reservation.hold({
    id: input.reservationId,
    terms: input.terms,
    holdDurationMs,
    now: input.now,
  });
  const connector = input.connector.placeHold(reservation.id, reservation.holdExpiresAt, input.now);
  return { kind: 'CREATED', reservation, connector };
}

export type ReleaseResult =
  | {
      readonly outcome: 'RELEASED' | 'ALREADY_RELEASED';
      readonly reservation: Reservation;
      readonly connector: ChargingConnector | undefined;
    }
  | { readonly outcome: 'VOIDED'; readonly tombstone: ReservationTombstone };

/**
 * Compensación: libera la reserva y el conector. Idempotente. Si la reserva no
 * existe, crea un tombstone para que un `PUT` tardío no deje un bloqueo huérfano.
 */
export function releaseReservation(input: {
  reservationId: ReservationId;
  reservation: Reservation | undefined;
  connector: ChargingConnector | undefined;
  reason: ReleaseReason;
  now: Date;
}): ReleaseResult {
  if (input.reservation === undefined) {
    return {
      outcome: 'VOIDED',
      tombstone: ReservationTombstone.create(input.reservationId, input.reason, input.now),
    };
  }
  const { reservation, outcome } = input.reservation.release(input.reason, input.now);
  return { outcome, reservation, connector: input.connector?.release(reservation.id) };
}

/** Paso final de la SAGA: confirma reserva y conector (la carga ya está activa). */
export function confirmReservation(input: {
  reservation: Reservation;
  connector: ChargingConnector;
  now: Date;
}): { reservation: Reservation; connector: ChargingConnector } {
  const reservation = input.reservation.confirm(input.now);
  const connector = input.connector.confirmHold(reservation.id, input.now);
  return { reservation, connector };
}
