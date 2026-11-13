import { describe, expect, it } from 'vitest';

import {
  DebitTermsMismatchError,
  DebitTombstone,
  DebitVoidedError,
  Energy,
  FleetId,
  InsufficientFundsError,
  InvalidDebitTransitionError,
  InvalidValueError,
  Money,
  TopUpId,
  Wallet,
  WalletTransaction,
  debitEstimatedCharge,
  refundDebit,
  topUpWallet,
} from '../../src/domain/index.ts';
import {
  DEBIT_ID,
  FLEET_ID,
  OFF_PEAK,
  SAGA_ID,
  TX_ID,
  TX_ID_2,
  cop,
  pricing,
  terms,
  wallet,
} from './fixtures.ts';

function charge(overrides: Partial<Parameters<typeof debitEstimatedCharge>[0]> = {}) {
  return debitEstimatedCharge({
    debitId: DEBIT_ID,
    transactionId: TX_ID,
    terms: terms(),
    wallet: wallet(5_000_000),
    existing: undefined,
    tombstone: undefined,
    pricing,
    surgePricingEnabled: false,
    now: OFF_PEAK,
    ...overrides,
  });
}

function debited() {
  const result = charge();
  if (result.kind !== 'DEBITED') {
    throw new Error('se esperaba DEBITED');
  }
  return result;
}

describe('Wallet', () => {
  it('abre con saldo cero y respeta saldo ≥ 0', () => {
    const opened = Wallet.open(FLEET_ID, 'COP', OFF_PEAK);
    expect(opened.balance.isZero).toBe(true);
    expect(() => opened.debit(cop(1), OFF_PEAK)).toThrow(InsufficientFundsError);
  });

  it('debit y credit devuelven instancias nuevas', () => {
    const original = wallet(1_000);
    const after = original.debit(cop(400), OFF_PEAK).credit(cop(100), OFF_PEAK);
    expect(after.balance.amountMinor).toBe(700);
    expect(original.balance.amountMinor).toBe(1_000);
  });

  it('rechaza importes en cero', () => {
    expect(() => wallet(1_000).credit(cop(0), OFF_PEAK)).toThrow(InvalidValueError);
  });
});

describe('WalletTransaction', () => {
  it('exige importe > 0 y misma moneda que el saldo resultante', () => {
    const base = { id: TX_ID, fleetId: FLEET_ID, balanceAfter: cop(100), occurredAt: OFF_PEAK };
    const reference = { type: 'TOP_UP' as const, topUpId: TopUpId.parse('tup_1') };

    expect(WalletTransaction.record({ ...base, amount: cop(100) }, reference).type).toBe('TOP_UP');
    expect(() => WalletTransaction.record({ ...base, amount: cop(0) }, reference)).toThrow(
      InvalidValueError,
    );
    expect(() =>
      WalletTransaction.record({ ...base, amount: Money.of(1, 'USD') }, reference),
    ).toThrow(/misma moneda/);
  });
});

describe('debitEstimatedCharge (paso 2 de la SAGA)', () => {
  it('cobra el importe calculado y registra la entrada DEBIT', () => {
    const { wallet: after, debit, transaction } = debited();

    expect(debit.status).toBe('DEBITED');
    expect(debit.amount.amountMinor).toBe(3_000_000);
    expect(after.balance.amountMinor).toBe(2_000_000);
    expect(transaction.type).toBe('DEBIT');
    expect(transaction.balanceAfter.equals(after.balance)).toBe(true);
    expect(transaction.reference).toEqual({ type: 'DEBIT', sagaId: SAGA_ID, debitId: DEBIT_ID });
  });

  it('con saldo insuficiente devuelve un débito REJECTED (sin tocar el saldo)', () => {
    const result = charge({ wallet: wallet(2_999_999) });

    expect(result.kind).toBe('REJECTED_INSUFFICIENT_FUNDS');
    expect(result.debit.status).toBe('REJECTED_INSUFFICIENT_FUNDS');
    expect(result).not.toHaveProperty('wallet');
  });

  it('repetir con los mismos términos devuelve el débito existente (REPLAYED)', () => {
    const { debit } = debited();
    expect(charge({ existing: debit })).toEqual({ kind: 'REPLAYED', debit });
  });

  it('el rechazo también es idempotente: el reintento obtiene el mismo resultado', () => {
    const rejected = charge({ wallet: wallet(1) }).debit;
    expect(charge({ existing: rejected, wallet: wallet(1) })).toEqual({
      kind: 'REPLAYED',
      debit: rejected,
    });
  });

  it('el mismo id con otros términos es un conflicto', () => {
    const { debit } = debited();
    expect(() => charge({ existing: debit, terms: terms({ energy: Energy.fromKwh(31) }) })).toThrow(
      DebitTermsMismatchError,
    );
  });

  it('un tombstone bloquea el cobro tardío', () => {
    expect(() => charge({ tombstone: DebitTombstone.create(DEBIT_ID, OFF_PEAK) })).toThrow(
      DebitVoidedError,
    );
  });

  it('la billetera debe ser de la flota del débito', () => {
    expect(() => charge({ terms: terms({ fleetId: FleetId.parse('fleet_999') }) })).toThrow(
      InvalidValueError,
    );
  });
});

describe('refundDebit (compensación)', () => {
  it('reembolsa una sola vez aunque se procese dos veces (§6.3)', () => {
    const { wallet: afterDebit, debit } = debited();

    const first = refundDebit({
      debitId: DEBIT_ID,
      transactionId: TX_ID_2,
      debit,
      wallet: afterDebit,
      now: OFF_PEAK,
    });
    expect(first.outcome).toBe('REFUNDED');
    if (first.outcome !== 'REFUNDED') return;
    expect(first.wallet.balance.amountMinor).toBe(5_000_000);
    expect(first.transaction.type).toBe('REFUND');

    const second = refundDebit({
      debitId: DEBIT_ID,
      transactionId: TX_ID_2,
      debit: first.debit,
      wallet: first.wallet,
      now: OFF_PEAK,
    });
    expect(second.outcome).toBe('ALREADY_REFUNDED');
    expect(second).not.toHaveProperty('wallet');
  });

  it('un débito rechazado no tiene nada que reembolsar', () => {
    const { debit } = charge({ wallet: wallet(1) });
    expect(
      refundDebit({
        debitId: DEBIT_ID,
        transactionId: TX_ID_2,
        debit,
        wallet: wallet(1),
        now: OFF_PEAK,
      }).outcome,
    ).toBe('NOTHING_TO_REFUND');
  });

  it('si el débito no existe deja un tombstone (VOIDED)', () => {
    const result = refundDebit({
      debitId: DEBIT_ID,
      transactionId: TX_ID_2,
      debit: undefined,
      wallet: undefined,
      now: OFF_PEAK,
    });
    expect(result.outcome).toBe('VOIDED');
  });

  it('markRefunded solo aplica a DEBITED', () => {
    const { debit } = debited();
    const refunded = debit.markRefunded(OFF_PEAK);
    expect(() => refunded.markRefunded(OFF_PEAK)).toThrow(InvalidDebitTransitionError);
  });
});

describe('topUpWallet', () => {
  it('acredita el saldo y registra la entrada TOP_UP', () => {
    const { wallet: after, transaction } = topUpWallet({
      topUpId: TopUpId.parse('tup_admin-001'),
      transactionId: TX_ID,
      wallet: wallet(0),
      amount: cop(10_000_000),
      now: OFF_PEAK,
    });
    expect(after.balance.amountMinor).toBe(10_000_000);
    expect(transaction.reference).toEqual({ type: 'TOP_UP', topUpId: 'tup_admin-001' });
  });
});
