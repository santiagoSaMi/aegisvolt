import { describe, expect, it } from 'vitest';

import {
  Debit,
  DebitMismatchError,
  DebitTermsMismatchError,
  DebitTombstone,
  DebitVoidedError,
  Energy,
  FleetId,
  InsufficientFundsError,
  InvalidDebitTransitionError,
  InvalidValueError,
  Money,
  OperationAudit,
  RefundId,
  TopUpId,
  TopUpTermsMismatchError,
  Wallet,
  WalletTransaction,
  WalletTransactionId,
  debitEstimatedCharge,
  refundDebit,
  topUpWallet,
} from '../../src/domain/index.ts';
import {
  AUDIT,
  DEBIT_ID,
  FLEET_ID,
  OFF_PEAK,
  OTHER_SAGA_ID,
  SAGA_ID,
  cop,
  pricing,
  terms,
  wallet,
} from './fixtures.ts';

function charge(overrides: Partial<Parameters<typeof debitEstimatedCharge>[0]> = {}) {
  return debitEstimatedCharge({
    debitId: DEBIT_ID,
    terms: terms(),
    wallet: wallet(5_000_000),
    existing: undefined,
    tombstone: undefined,
    pricing,
    surgePricingEnabled: false,
    audit: AUDIT,
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

function refund(debit: Debit | undefined, current: Wallet | undefined, requestedBy = SAGA_ID) {
  return refundDebit({
    debitId: DEBIT_ID,
    requestedBy,
    debit,
    wallet: current,
    reason: 'CHARGER_HARDWARE_FAULT',
    audit: AUDIT,
    now: OFF_PEAK,
  });
}

describe('Wallet', () => {
  it('abre con saldo cero y el saldo nunca queda negativo', () => {
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

  it('rechaza importes en cero y monedas distintas', () => {
    expect(() => wallet(1_000).credit(cop(0), OFF_PEAK)).toThrow(InvalidValueError);
    expect(() => wallet(1_000).debit(Money.of(1, 'USD'), OFF_PEAK)).toThrow(/USD/);
  });
});

describe('Identificadores derivados', () => {
  it('reembolso y movimientos tienen ids deterministas por operación', () => {
    expect(RefundId.forDebit(DEBIT_ID)).toBe('rfd_3f2c1e5a-1b2c-4d3e-8f90-123456789abc');
    expect(WalletTransactionId.forOperation('debit', DEBIT_ID)).toBe(
      'wtx_debit-3f2c1e5a-1b2c-4d3e-8f90-123456789abc',
    );
  });

  it('OperationAudit exige correlationId UUID y una clave idempotente válida', () => {
    expect(() => OperationAudit.of('c-1', 'k')).toThrow(InvalidValueError);
    expect(() => OperationAudit.of('11111111-2222-4333-8444-555555555555', 'con espacio')).toThrow(
      InvalidValueError,
    );
  });
});

describe('WalletTransaction', () => {
  it('exige importe > 0, misma moneda que el saldo y conserva la trazabilidad', () => {
    const base = { fleetId: FLEET_ID, balanceAfter: cop(100), occurredAt: OFF_PEAK };
    const reference = { type: 'TOP_UP' as const, topUpId: TopUpId.parse('tup_1') };

    const entry = WalletTransaction.record({ ...base, amount: cop(100) }, reference, AUDIT);
    expect(entry).toMatchObject({ type: 'TOP_UP', operationId: 'tup_1', id: 'wtx_topup-1' });
    expect(entry.audit).toBe(AUDIT);
    expect(() => WalletTransaction.record({ ...base, amount: cop(0) }, reference, AUDIT)).toThrow(
      InvalidValueError,
    );
    expect(() =>
      WalletTransaction.record({ ...base, amount: Money.of(1, 'USD') }, reference, AUDIT),
    ).toThrow(/misma moneda/);
  });
});

describe('debitEstimatedCharge (paso 2 de la SAGA)', () => {
  it('cobra el importe calculado por el servicio y registra el movimiento DEBIT', () => {
    const { wallet: after, debit, transaction } = debited();

    expect(debit.status).toBe('DEBITED');
    expect(debit.amount.amountMinor).toBe(3_000_000);
    expect(after.balance.amountMinor).toBe(2_000_000);
    expect(transaction).toMatchObject({ type: 'DEBIT', operationId: DEBIT_ID, sagaId: SAGA_ID });
    expect(transaction.balanceAfter.equals(after.balance)).toBe(true);
  });

  it('fondos insuficientes: débito RECHAZADO, sin movimiento ni cambio de saldo', () => {
    const result = charge({ wallet: wallet(2_999_999) });

    expect(result.kind).toBe('REJECTED_INSUFFICIENT_FUNDS');
    expect(result.debit.status).toBe('REJECTED_INSUFFICIENT_FUNDS');
    expect(result).not.toHaveProperty('wallet');
    expect(result).not.toHaveProperty('transaction');
  });

  it('débito duplicado con la misma clave: REPLAYED, no cobra dos veces', () => {
    const { debit } = debited();
    expect(charge({ existing: debit })).toEqual({ kind: 'REPLAYED', debit });
  });

  it('el rechazo también es idempotente', () => {
    const rejected = charge({ wallet: wallet(1) }).debit;
    expect(charge({ existing: rejected, wallet: wallet(1) })).toEqual({
      kind: 'REPLAYED',
      debit: rejected,
    });
  });

  it('la misma clave con otros términos es un conflicto', () => {
    const { debit } = debited();
    expect(() => charge({ existing: debit, terms: terms({ energy: Energy.fromKwh(31) }) })).toThrow(
      DebitTermsMismatchError,
    );
  });

  it('un tombstone bloquea el cobro tardío', () => {
    const tombstone = DebitTombstone.create(DEBIT_ID, SAGA_ID, AUDIT, OFF_PEAK);
    expect(() => charge({ tombstone })).toThrow(DebitVoidedError);
  });

  it('la billetera debe ser de la flota del débito', () => {
    expect(() => charge({ terms: terms({ fleetId: FleetId.parse('fleet_999') }) })).toThrow(
      InvalidValueError,
    );
  });
});

describe('refundDebit (compensación como operación propia)', () => {
  it('crea un Refund con su movimiento REFUND y restituye el saldo', () => {
    const { wallet: afterDebit, debit } = debited();
    const result = refund(debit, afterDebit);

    expect(result.outcome).toBe('REFUNDED');
    if (result.outcome !== 'REFUNDED') return;
    expect(result.wallet.balance.amountMinor).toBe(5_000_000);
    expect(result.refund).toMatchObject({
      id: RefundId.forDebit(DEBIT_ID),
      debitId: DEBIT_ID,
      reason: 'CHARGER_HARDWARE_FAULT',
    });
    expect(result.refund.amount.equals(debit.amount)).toBe(true);
    expect(result.debit).toMatchObject({ status: 'REFUNDED', refundId: result.refund.id });
    expect(result.transaction).toMatchObject({ type: 'REFUND', operationId: result.refund.id });
  });

  it('reembolso duplicado: ALREADY_REFUNDED sin tocar el saldo (§6.3)', () => {
    const { wallet: afterDebit, debit } = debited();
    const first = refund(debit, afterDebit);
    if (first.outcome !== 'REFUNDED') throw new Error('se esperaba REFUNDED');

    const second = refund(first.debit, first.wallet);
    expect(second.outcome).toBe('ALREADY_REFUNDED');
    expect(second).not.toHaveProperty('wallet');
  });

  it('solo la SAGA dueña del débito puede reembolsarlo', () => {
    const { wallet: afterDebit, debit } = debited();
    expect(() => refund(debit, afterDebit, OTHER_SAGA_ID)).toThrow(DebitMismatchError);
  });

  it('un débito rechazado no tiene nada que reembolsar', () => {
    const { debit } = charge({ wallet: wallet(1) });
    expect(refund(debit, wallet(1)).outcome).toBe('NOTHING_TO_REFUND');
  });

  it('reembolso de un débito inexistente: tombstone (VOIDED) trazable', () => {
    const result = refund(undefined, undefined);
    expect(result.outcome).toBe('VOIDED');
    if (result.outcome === 'VOIDED') {
      expect(result.tombstone).toMatchObject({ id: DEBIT_ID, sagaId: SAGA_ID, audit: AUDIT });
    }
  });

  it('markRefunded solo aplica a DEBITED y restore exige refundId en REFUNDED', () => {
    const { debit } = debited();
    const refunded = debit.markRefunded(RefundId.forDebit(DEBIT_ID), OFF_PEAK);
    expect(() => refunded.markRefunded(RefundId.forDebit(DEBIT_ID), OFF_PEAK)).toThrow(
      InvalidDebitTransitionError,
    );
    expect(() =>
      Debit.restore({
        id: debit.id,
        terms: debit.terms,
        quote: debit.quote,
        status: 'REFUNDED',
        audit: AUDIT,
        createdAt: OFF_PEAK,
        updatedAt: OFF_PEAK,
      }),
    ).toThrow(InvalidValueError);
  });
});

describe('topUpWallet', () => {
  const topUpId = TopUpId.parse('tup_admin-001');

  it('acredita el saldo, registra la recarga y su movimiento TOP_UP', () => {
    const result = topUpWallet({
      topUpId,
      wallet: wallet(0),
      amount: cop(10_000_000),
      existing: undefined,
      audit: AUDIT,
      now: OFF_PEAK,
    });
    expect(result.kind).toBe('APPLIED');
    if (result.kind !== 'APPLIED') return;
    expect(result.wallet.balance.amountMinor).toBe(10_000_000);
    expect(result.transaction).toMatchObject({ type: 'TOP_UP', operationId: topUpId });
  });

  it('es idempotente por topUpId y detecta otro importe con la misma clave', () => {
    const applied = topUpWallet({
      topUpId,
      wallet: wallet(0),
      amount: cop(100),
      existing: undefined,
      audit: AUDIT,
      now: OFF_PEAK,
    });
    if (applied.kind !== 'APPLIED') throw new Error('se esperaba APPLIED');
    const base = {
      topUpId,
      wallet: wallet(100),
      existing: applied.topUp,
      audit: AUDIT,
      now: OFF_PEAK,
    };

    expect(topUpWallet({ ...base, amount: cop(100) }).kind).toBe('REPLAYED');
    expect(() => topUpWallet({ ...base, amount: cop(200) })).toThrow(TopUpTermsMismatchError);
  });
});
