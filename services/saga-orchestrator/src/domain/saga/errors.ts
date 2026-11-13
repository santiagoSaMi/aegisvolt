import { DomainError } from '../shared/domain-error.ts';

/** Transición no permitida desde el estado actual de la SAGA. */
export class InvalidSagaTransitionError extends DomainError {
  readonly code = 'INVALID_SAGA_TRANSITION';
}
