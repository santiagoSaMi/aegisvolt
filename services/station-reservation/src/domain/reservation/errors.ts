import { DomainError } from '../shared/domain-error.ts';

/** El conector no está disponible (reservado por otro, fuera de servicio). */
export class ConnectorUnavailableError extends DomainError {
  readonly code = 'CONNECTOR_UNAVAILABLE';
}

/** Se pidió `fastChargeBoost` con `ENABLE_FAST_CHARGE_BOOST` apagada en el ambiente. */
export class FastChargeBoostDisabledError extends DomainError {
  readonly code = 'FAST_CHARGE_BOOST_DISABLED';
}

/** Los conectores de ultra-carga solo se reservan con `fastChargeBoost` (interpretación P-14). */
export class UltraFastRequiresBoostError extends DomainError {
  readonly code = 'ULTRA_FAST_REQUIRES_BOOST';
}

/** El id de reserva tiene un tombstone: ya se compensó y no puede crearse después. */
export class ReservationCancelledError extends DomainError {
  readonly code = 'RESERVATION_CANCELLED';
}

/** La operación exige una reserva en estado HELD. */
export class ReservationNotHeldError extends DomainError {
  readonly code = 'RESERVATION_NOT_HELD';
}

/** El *hold* venció antes de confirmarse. */
export class ReservationHoldExpiredError extends DomainError {
  readonly code = 'RESERVATION_HOLD_EXPIRED';
}

/** Mismo id de reserva con otros términos (protección de idempotencia). */
export class ReservationTermsMismatchError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}
