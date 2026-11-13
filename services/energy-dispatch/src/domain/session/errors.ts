import { DomainError } from '../shared/domain-error.ts';

/** El id de sesión tiene un tombstone (se abortó antes de activarse). */
export class SessionAbortedError extends DomainError {
  readonly code = 'SESSION_ABORTED';
}

/** La carga ya terminó: no se puede abortar como compensación. */
export class SessionAlreadyCompletedError extends DomainError {
  readonly code = 'SESSION_ALREADY_COMPLETED';
}

/** Operación que exige una sesión ACTIVE (completar, registrar telemetría). */
export class SessionNotActiveError extends DomainError {
  readonly code = 'SESSION_NOT_ACTIVE';
}

/** Mismo id de sesión con otros términos (protección de idempotencia). */
export class SessionTermsMismatchError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** Lectura de telemetría fuera de orden o inconsistente con la anterior. */
export class TelemetryOutOfOrderError extends DomainError {
  readonly code = 'TELEMETRY_OUT_OF_ORDER';
}
