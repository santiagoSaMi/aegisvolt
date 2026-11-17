import { CurrencyMismatchError, type Money } from '../money/money.ts';
import { InvalidValueError } from '../shared/domain-error.ts';
import {
  WalletTransactionId,
  type DebitId,
  type FleetId,
  type RefundId,
  type SagaId,
  type TopUpId,
} from '../shared/identifiers.ts';
import type { OperationAudit } from '../shared/operation-audit.ts';

export const WALLET_TRANSACTION_TYPES = ['DEBIT', 'REFUND', 'TOP_UP'] as const;
export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPES)[number];

/** Operación que origina el movimiento. Cargos y reembolsos pertenecen a una SAGA. */
export type WalletTransactionReference =
  | { readonly type: 'DEBIT'; readonly sagaId: SagaId; readonly debitId: DebitId }
  | {
      readonly type: 'REFUND';
      readonly sagaId: SagaId;
      readonly debitId: DebitId;
      readonly refundId: RefundId;
    }
  | { readonly type: 'TOP_UP'; readonly topUpId: TopUpId };

export interface WalletTransactionEntry {
  readonly fleetId: FleetId;
  readonly amount: Money;
  readonly balanceAfter: Money;
  readonly occurredAt: Date;
}

/**
 * Movimiento del libro mayor (append-only, inmutable). Las correcciones se hacen
 * con movimientos nuevos (REFUND), nunca editando. Invariantes: importe > 0 y
 * misma moneda que el saldo resultante. Su id se deriva de la operación que lo
 * origina, de modo que cada operación produce exactamente un movimiento.
 */
export class WalletTransaction {
  readonly id: WalletTransactionId;
  readonly fleetId: FleetId;
  readonly amount: Money;
  readonly balanceAfter: Money;
  readonly occurredAt: Date;
  readonly reference: WalletTransactionReference;
  readonly audit: OperationAudit;

  private constructor(
    entry: WalletTransactionEntry,
    reference: WalletTransactionReference,
    audit: OperationAudit,
  ) {
    this.id = WalletTransactionId.forOperation(kindOf(reference), operationIdOf(reference));
    this.fleetId = entry.fleetId;
    this.amount = entry.amount;
    this.balanceAfter = entry.balanceAfter;
    this.occurredAt = entry.occurredAt;
    this.reference = reference;
    this.audit = audit;
  }

  static record(
    entry: WalletTransactionEntry,
    reference: WalletTransactionReference,
    audit: OperationAudit,
  ): WalletTransaction {
    if (entry.amount.isZero) {
      throw new InvalidValueError('amount', 'una transacción debe tener importe > 0');
    }
    if (entry.amount.currency !== entry.balanceAfter.currency) {
      throw new CurrencyMismatchError(
        'El importe y el saldo resultante deben tener la misma moneda',
      );
    }
    return new WalletTransaction(entry, reference, audit);
  }

  get type(): WalletTransactionType {
    return this.reference.type;
  }

  /** Id de la operación de negocio que originó el movimiento (débito, reembolso o recarga). */
  get operationId(): string {
    return operationIdOf(this.reference);
  }

  get sagaId(): SagaId | undefined {
    return this.reference.type === 'TOP_UP' ? undefined : this.reference.sagaId;
  }
}

function operationIdOf(reference: WalletTransactionReference): string {
  switch (reference.type) {
    case 'DEBIT':
      return reference.debitId;
    case 'REFUND':
      return reference.refundId;
    case 'TOP_UP':
      return reference.topUpId;
  }
}

function kindOf(reference: WalletTransactionReference): 'debit' | 'refund' | 'topup' {
  switch (reference.type) {
    case 'DEBIT':
      return 'debit';
    case 'REFUND':
      return 'refund';
    case 'TOP_UP':
      return 'topup';
  }
}
