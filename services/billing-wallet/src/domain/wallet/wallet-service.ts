import type { Money } from '../money/money.ts';
import type { PricingPolicy } from '../pricing/pricing-policy.ts';
import { InvalidValueError } from '../shared/domain-error.ts';
import type { DebitId, SagaId, TopUpId } from '../shared/identifiers.ts';
import type { OperationAudit } from '../shared/operation-audit.ts';
import { Debit, DebitTombstone, type DebitTerms } from './debit.ts';
import { DebitTermsMismatchError, DebitVoidedError, TopUpTermsMismatchError } from './errors.ts';
import { Refund, type RefundReason } from './refund.ts';
import { TopUp } from './top-up.ts';
import type { Wallet } from './wallet.ts';
import { WalletTransaction } from './wallet-transaction.ts';

/**
 * Servicios de dominio de la billetera. Funciones puras: la aplicación persiste
 * el resultado en UNA transacción (saldo + operación + movimiento del libro mayor).
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

/**
 * Paso 2 de la SAGA: cobra el importe estimado (idempotente por `debitId`).
 * - El importe sale de la política de precios, nunca del cliente.
 * - Sin saldo suficiente no hay movimiento: se registra el débito RECHAZADO.
 * - Repetir con los mismos términos devuelve el débito original (no cobra dos veces).
 */
export function debitEstimatedCharge(input: {
  debitId: DebitId;
  terms: DebitTerms;
  wallet: Wallet;
  existing: Debit | undefined;
  tombstone: DebitTombstone | undefined;
  pricing: PricingPolicy;
  surgePricingEnabled: boolean;
  audit: OperationAudit;
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
      debit: Debit.rejected(input.debitId, input.terms, quote, input.audit, input.now),
    };
  }

  const wallet = input.wallet.debit(quote.amount, input.now);
  const debit = Debit.applied(input.debitId, input.terms, quote, input.audit, input.now);
  const transaction = WalletTransaction.record(
    {
      fleetId: wallet.fleetId,
      amount: quote.amount,
      balanceAfter: wallet.balance,
      occurredAt: input.now,
    },
    { type: 'DEBIT', sagaId: input.terms.sagaId, debitId: debit.id },
    input.audit,
  );
  return { kind: 'DEBITED', wallet, debit, transaction };
}

export type RefundResult =
  | {
      readonly outcome: 'REFUNDED';
      readonly wallet: Wallet;
      readonly debit: Debit;
      readonly refund: Refund;
      readonly transaction: WalletTransaction;
    }
  | { readonly outcome: 'ALREADY_REFUNDED' | 'NOTHING_TO_REFUND'; readonly debit: Debit }
  | { readonly outcome: 'VOIDED'; readonly tombstone: DebitTombstone };

/**
 * Compensación: reembolsa un débito como operación propia (Refund + movimiento REFUND).
 * - Solo la SAGA dueña del débito puede pedirlo (DEBIT_MISMATCH).
 * - ALREADY_REFUNDED: no toca el saldo (evita el reembolso doble, §6.3).
 * - NOTHING_TO_REFUND: el débito fue rechazado; no hubo cobro.
 * - VOIDED: el débito no existe; tombstone que bloquea un cobro tardío.
 */
export function refundDebit(input: {
  debitId: DebitId;
  requestedBy: SagaId;
  debit: Debit | undefined;
  wallet: Wallet | undefined;
  reason: RefundReason;
  audit: OperationAudit;
  now: Date;
}): RefundResult {
  if (input.debit === undefined) {
    return {
      outcome: 'VOIDED',
      tombstone: DebitTombstone.create(input.debitId, input.requestedBy, input.audit, input.now),
    };
  }
  input.debit.assertRequestedBy(input.requestedBy);
  if (input.debit.status === 'REFUNDED') {
    return { outcome: 'ALREADY_REFUNDED', debit: input.debit };
  }
  if (input.debit.status === 'REJECTED_INSUFFICIENT_FUNDS') {
    return { outcome: 'NOTHING_TO_REFUND', debit: input.debit };
  }
  if (input.wallet?.fleetId !== input.debit.terms.fleetId) {
    throw new InvalidValueError('wallet', 'se requiere la billetera de la flota del débito');
  }

  const refund = Refund.of(input.debit, input.reason, input.audit, input.now);
  const wallet = input.wallet.credit(refund.amount, input.now);
  const debit = input.debit.markRefunded(refund.id, input.now);
  const transaction = WalletTransaction.record(
    {
      fleetId: wallet.fleetId,
      amount: refund.amount,
      balanceAfter: wallet.balance,
      occurredAt: input.now,
    },
    { type: 'REFUND', sagaId: debit.terms.sagaId, debitId: debit.id, refundId: refund.id },
    input.audit,
  );
  return { outcome: 'REFUNDED', wallet, debit, refund, transaction };
}

export type TopUpResult =
  | {
      readonly kind: 'APPLIED';
      readonly wallet: Wallet;
      readonly topUp: TopUp;
      readonly transaction: WalletTransaction;
    }
  | { readonly kind: 'REPLAYED'; readonly topUp: TopUp };

/** Recarga administrativa: suma un importe positivo (nunca fija el saldo). Idempotente. */
export function topUpWallet(input: {
  topUpId: TopUpId;
  wallet: Wallet;
  amount: Money;
  existing: TopUp | undefined;
  audit: OperationAudit;
  now: Date;
}): TopUpResult {
  if (input.existing !== undefined) {
    if (!input.existing.hasSameTerms(input.wallet.fleetId, input.amount)) {
      throw new TopUpTermsMismatchError(`La recarga ${input.topUpId} ya existe con otro importe`);
    }
    return { kind: 'REPLAYED', topUp: input.existing };
  }
  const topUp = TopUp.create({
    id: input.topUpId,
    fleetId: input.wallet.fleetId,
    amount: input.amount,
    audit: input.audit,
    createdAt: input.now,
  });
  const wallet = input.wallet.credit(input.amount, input.now);
  const transaction = WalletTransaction.record(
    {
      fleetId: wallet.fleetId,
      amount: input.amount,
      balanceAfter: wallet.balance,
      occurredAt: input.now,
    },
    { type: 'TOP_UP', topUpId: topUp.id },
    input.audit,
  );
  return { kind: 'APPLIED', wallet, topUp, transaction };
}
