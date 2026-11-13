import { DomainError } from '../shared/domain-error.ts';

/** Transición no permitida desde el estado actual de la SAGA. */
export class InvalidSagaTransitionError extends DomainError {
  readonly code = 'INVALID_SAGA_TRANSITION';
}

/** Se pidió reintentar la compensación de una SAGA que no está en COMPENSATION_FAILED. */
export class SagaNotRetryableError extends DomainError {
  readonly code = 'SAGA_NOT_RETRYABLE';
}

/** Misma clave idempotente con una petición distinta. */
export class IdempotencyKeyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}
