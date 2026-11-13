import { CurrencyMismatchError, type Money } from '../money/money.ts';
import { InvalidValueError } from '../shared/domain-error.ts';
import type {
  DebitId,
  FleetId,
  SagaId,
  TopUpId,
  WalletTransactionId,
} from '../shared/identifiers.ts';

export const WALLET_TRANSACTION_TYPES = ['DEBIT', 'REFUND', 'TOP_UP'] as const;
export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPES)[number];

interface BaseEntry {
  readonly id: WalletTransactionId;
  readonly fleetId: FleetId;
  readonly amount: Money;
  readonly balanceAfter: Money;
  readonly occurredAt: Date;
}

/** Referencias según el tipo: los cargos y reembolsos pertenecen a una SAGA. */
export type WalletTransactionReference =
  | { readonly type: 'DEBIT' | 'REFUND'; readonly sagaId: SagaId; readonly debitId: DebitId }
  | { readonly type: 'TOP_UP'; readonly topUpId: TopUpId };

/**
 * Entrada del libro mayor de la billetera. Inmutable (append-only): las
 * correcciones se hacen con nuevas entradas (p. ej. REFUND), nunca editando.
 * Invariantes: importe > 0 y misma moneda que el saldo resultante.
 */
export class WalletTransaction {
  readonly id: WalletTransactionId;
  readonly fleetId: FleetId;
  readonly amount: Money;
  readonly balanceAfter: Money;
  readonly occurredAt: Date;
  readonly reference: WalletTransactionReference;

  private constructor(entry: BaseEntry, reference: WalletTransactionReference) {
    this.id = entry.id;
    this.fleetId = entry.fleetId;
    this.amount = entry.amount;
    this.balanceAfter = entry.balanceAfter;
    this.occurredAt = entry.occurredAt;
    this.reference = reference;
  }

  static record(entry: BaseEntry, reference: WalletTransactionReference): WalletTransaction {
    if (entry.amount.isZero) {
      throw new InvalidValueError('amount', 'una transacción debe tener importe > 0');
    }
    if (entry.amount.currency !== entry.balanceAfter.currency) {
      throw new CurrencyMismatchError(
        'El importe y el saldo resultante deben tener la misma moneda',
      );
    }
    return new WalletTransaction(entry, reference);
  }

  get type(): WalletTransactionType {
    return this.reference.type;
  }
}
