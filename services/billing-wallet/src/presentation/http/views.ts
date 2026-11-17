import type { billingWalletV1 } from '@aegisvolt/contracts';
import type { z } from 'zod';

import type { FundsCheck } from '../../application/index.ts';
import type { Debit, Money, PriceQuote, Wallet, WalletTransaction } from '../../domain/index.ts';

/**
 * Domain → vistas públicas del contrato billing-wallet v1. Se tipan con
 * `z.input` del esquema: lo que el servidor envía es la entrada que valida el consumidor.
 */
type WalletView = z.input<typeof billingWalletV1.walletViewSchema>;
type WalletTransactionView = z.input<typeof billingWalletV1.walletTransactionViewSchema>;
type DebitView = z.input<typeof billingWalletV1.debitViewSchema>;
type FundsCheckView = z.input<typeof billingWalletV1.fundsCheckViewSchema>;

const money = (value: Money) => ({ amountMinor: value.amountMinor, currency: value.currency });

const pricing = (quote: PriceQuote) => ({
  tariffMinorPerKwh: quote.tariffMinorPerKwh,
  surgeMultiplierBasisPoints: quote.surgeMultiplierBasisPoints,
  surgeApplied: quote.surgeApplied,
});

export function toWalletView(wallet: Wallet): WalletView {
  return {
    fleetId: wallet.fleetId,
    balance: money(wallet.balance),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toTransactionView(transaction: WalletTransaction): WalletTransactionView {
  const reference = transaction.reference;
  return {
    transactionId: transaction.id,
    fleetId: transaction.fleetId,
    type: transaction.type,
    amount: money(transaction.amount),
    balanceAfter: money(transaction.balanceAfter),
    operationId: transaction.operationId,
    ...(reference.type === 'TOP_UP'
      ? { topUpId: reference.topUpId }
      : { sagaId: reference.sagaId, debitId: reference.debitId }),
    ...(reference.type === 'REFUND' ? { refundId: reference.refundId } : {}),
    correlationId: transaction.audit.correlationId,
    idempotencyKey: transaction.audit.idempotencyKey,
    occurredAt: transaction.occurredAt.toISOString(),
  };
}

export function toDebitView(debit: Debit): DebitView {
  return {
    debitId: debit.id,
    sagaId: debit.terms.sagaId,
    fleetId: debit.terms.fleetId,
    status: debit.status,
    amount: money(debit.amount),
    pricing: pricing(debit.quote),
    ...(debit.refundId === undefined ? {} : { refundId: debit.refundId }),
    createdAt: debit.createdAt.toISOString(),
    updatedAt: debit.updatedAt.toISOString(),
  };
}

export function toFundsCheckView(check: FundsCheck): FundsCheckView {
  return {
    fleetId: check.wallet.fleetId,
    sufficient: check.sufficient,
    required: money(check.required),
    available: money(check.wallet.balance),
    pricing: pricing(check.quote),
  };
}
