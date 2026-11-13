import { InvalidValueError } from '../shared/domain-error.ts';
import type { DebitId, TopUpId, WalletTransactionId } from '../shared/identifiers.ts';
import type { Money } from '../money/money.ts';
import type { PricingPolicy } from '../pricing/pricing-policy.ts';
import { Debit, DebitTombstone, type DebitTerms } from './debit.ts';
import { DebitTermsMismatchError, DebitVoidedError } from './errors.ts';
import type { Wallet } from './wallet.ts';
import { WalletTransaction } from './wallet-transaction.ts';

/**
 * Servicios de dominio de la billetera. Funciones puras: la aplicación persiste
 * billetera + débito + entrada del libro mayor en una sola transacción.
 */

export type DebitResult =
  | {
      readonly kind: 'DEBITED';
      readonly wallet: Wallet;
      readonly debit: Debit;
      readonly transaction: WalletTransaction;
    }
  | { readonly kind: 'REJECTED_INSUFFICIENT_FUNDS'; readonly debit: Debit }
  | { readonly kind: 'REPLAYED'; readonly debit: Debit };

/** Paso 2 de la SAGA: cobra el importe estimado (PUT idempotente por `debitId`). */
export function debitEstimatedCharge(input: {
  debitId: DebitId;
  transactionId: WalletTransactionId;
  terms: DebitTerms;
  wallet: Wallet;
  existing: Debit | undefined;
  tombstone: DebitTombstone | undefined;
  pricing: PricingPolicy;
  surgePricingEnabled: boolean;
  now: Date;
}): DebitResult {
  if (input.tombstone !== undefined) {
    throw new DebitVoidedError(`El débito ${input.debitId} ya fue compensado`);
  }
  if (input.existing !== undefined) {
    if (!input.existing.hasSameTerms(input.terms)) {
      throw new DebitTermsMismatchError(`El débito ${input.debitId} ya existe con otros términos`);
    }
    return { kind: 'REPLAYED', debit: input.existing };
  }
  if (input.wallet.fleetId !== input.terms.fleetId) {
    throw new InvalidValueError('fleetId', 'la billetera no pertenece a la flota indicada');
  }

  const quote = input.pricing.quote({
    energy: input.terms.energy,
    connectorPowerKw: input.terms.connectorPowerKw,
    at: input.now,
    surgePricingEnabled: input.surgePricingEnabled,
  });

  if (!input.wallet.canAfford(quote.amount)) {
    return {
      kind: 'REJECTED_INSUFFICIENT_FUNDS',
      debit: Debit.rejected(input.debitId, input.terms, quote, input.now),
    };
  }

  const wallet = input.wallet.debit(quote.amount, input.now);
  const debit = Debit.applied(input.debitId, input.terms, quote, input.now);
  const transaction = WalletTransaction.record(
    {
      id: input.transactionId,
      fleetId: wallet.fleetId,
      amount: quote.amount,
      balanceAfter: wallet.balance,
      occurredAt: input.now,
    },
    { type: 'DEBIT', sagaId: input.terms.sagaId, debitId: debit.id },
  );
  return { kind: 'DEBITED', wallet, debit, transaction };
}

export type RefundResult =
  | {
      readonly outcome: 'REFUNDED';
      readonly wallet: Wallet;
      readonly debit: Debit;
      readonly transaction: WalletTransaction;
    }
  | { readonly outcome: 'ALREADY_REFUNDED' | 'NOTHING_TO_REFUND'; readonly debit: Debit }
  | { readonly outcome: 'VOIDED'; readonly tombstone: DebitTombstone };

/**
 * Compensación: reembolsa un débito. Idempotente:
 * - REFUNDED: devuelve el importe y registra una entrada REFUND.
 * - ALREADY_REFUNDED: no toca el saldo (evita el reembolso doble, §6.3).
 * - NOTHING_TO_REFUND: el débito fue rechazado; no hubo cobro.
 * - VOIDED: el débito no existe; tombstone que bloquea un cobro tardío.
 */
export function refundDebit(input: {
  debitId: DebitId;
  transactionId: WalletTransactionId;
  debit: Debit | undefined;
  wallet: Wallet | undefined;
  now: Date;
}): RefundResult {
  if (input.debit === undefined) {
    return { outcome: 'VOIDED', tombstone: DebitTombstone.create(input.debitId, input.now) };
  }
  if (input.debit.status === 'REFUNDED') {
    return { outcome: 'ALREADY_REFUNDED', debit: input.debit };
  }
  if (input.debit.status === 'REJECTED_INSUFFICIENT_FUNDS') {
    return { outcome: 'NOTHING_TO_REFUND', debit: input.debit };
  }
  if (input.wallet?.fleetId !== input.debit.terms.fleetId) {
    throw new InvalidValueError('wallet', 'se requiere la billetera de la flota del débito');
  }

  const wallet = input.wallet.credit(input.debit.amount, input.now);
  const debit = input.debit.markRefunded(input.now);
  const transaction = WalletTransaction.record(
    {
      id: input.transactionId,
      fleetId: wallet.fleetId,
      amount: debit.amount,
      balanceAfter: wallet.balance,
      occurredAt: input.now,
    },
    { type: 'REFUND', sagaId: debit.terms.sagaId, debitId: debit.id },
  );
  return { outcome: 'REFUNDED', wallet, debit, transaction };
}

/** Recarga administrativa de saldo (idempotente por `topUpId` en la aplicación). */
export function topUpWallet(input: {
  topUpId: TopUpId;
  transactionId: WalletTransactionId;
  wallet: Wallet;
  amount: Money;
  now: Date;
}): { wallet: Wallet; transaction: WalletTransaction } {
  const wallet = input.wallet.credit(input.amount, input.now);
  const transaction = WalletTransaction.record(
    {
      id: input.transactionId,
      fleetId: wallet.fleetId,
      amount: input.amount,
      balanceAfter: wallet.balance,
      occurredAt: input.now,
    },
    { type: 'TOP_UP', topUpId: input.topUpId },
  );
  return { wallet, transaction };
}
