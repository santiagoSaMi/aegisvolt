import { DomainError } from '../shared/domain-error.ts';

/** Saldo insuficiente para el cargo estimado (resultado de negocio definitivo). */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

/** El id de débito tiene un tombstone: ya se compensó y no puede cobrarse después. */
export class DebitVoidedError extends DomainError {
  readonly code = 'DEBIT_VOIDED';
}

/** Mismo id de débito con otros términos (protección de idempotencia). */
export class DebitTermsMismatchError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** Transición de estado no permitida sobre un débito. */
export class InvalidDebitTransitionError extends DomainError {
  readonly code = 'INVALID_DEBIT_TRANSITION';
}
