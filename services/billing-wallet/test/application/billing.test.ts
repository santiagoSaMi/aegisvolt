import { beforeEach, describe, expect, it } from 'vitest';

import {
  ConcurrentModificationError,
  InvalidCursorError,
  WalletNotFoundError,
} from '../../src/application/index.ts';
import {
  DebitMismatchError,
  DebitTermsMismatchError,
  DebitVoidedError,
  InsufficientFundsError,
} from '../../src/domain/index.ts';
import {
  CORRELATION,
  DEBIT_A,
  DEBIT_AMOUNT,
  DEBIT_B,
  FLEET,
  SAGA_A,
  SAGA_B,
  createTestContext,
  debitCommand,
} from '../support/fixtures.ts';

let ctx: ReturnType<typeof createTestContext>;

beforeEach(() => {
  ctx = createTestContext();
});

const refund = (debitId = DEBIT_A, sagaId = SAGA_A) =>
  ctx.useCases.refundWallet.execute({
    debitId,
    sagaId,
    reason: 'CHARGER_HARDWARE_FAULT',
    audit: { correlationId: CORRELATION },
  });

describe('DebitWallet', () => {
  it('debita el importe calculado por el servicio y registra el movimiento con su auditoría', async () => {
    await ctx.fund(5_000_000);
    const { outcome, debit } = await ctx.useCases.debitWallet.execute(debitCommand());

    expect(outcome).toBe('DEBITED');
    expect(debit.amount.amountMinor).toBe(DEBIT_AMOUNT);
    expect(ctx.wallets.balanceOf(FLEET)).toBe(2_000_000);

    const movement = ctx.wallets.ledger.find((entry) => entry.type === 'DEBIT');
    expect(movement).toMatchObject({
      operationId: DEBIT_A,
      sagaId: SAGA_A,
      audit: { correlationId: CORRELATION, idempotencyKey: DEBIT_A },
    });
    expect(movement?.balanceAfter.amountMinor).toBe(2_000_000);
  });

  it('fondos insuficientes: 422, débito RECHAZADO auditable, saldo y libro mayor intactos', async () => {
    await ctx.fund(DEBIT_AMOUNT - 1);
    const ledgerBefore = ctx.wallets.ledger.length;

    await expect(ctx.useCases.debitWallet.execute(debitCommand())).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(ctx.wallets.balanceOf(FLEET)).toBe(DEBIT_AMOUNT - 1);
    expect(ctx.wallets.ledger).toHaveLength(ledgerBefore);
    const stored = ctx.wallets.debits.get(DEBIT_A);
    expect(stored?.kind === 'DEBIT' && stored.debit.value.status).toBe(
      'REJECTED_INSUFFICIENT_FUNDS',
    );

    // El reintento obtiene el mismo resultado aunque ahora hubiera saldo.
    await ctx.useCases.topUpWallet.execute({
      fleetId: FLEET,
      topUpId: 'tup_extra',
      amount: { amountMinor: 10_000_000, currency: 'COP' },
      audit: { correlationId: CORRELATION, idempotencyKey: 'tup_extra' },
    });
    await expect(ctx.useCases.debitWallet.execute(debitCommand())).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
  });

  it('débito duplicado con la misma clave: no descuenta dos veces', async () => {
    await ctx.fund(5_000_000);
    await ctx.useCases.debitWallet.execute(debitCommand());
    const writes = ctx.wallets.writes;

    const replay = await ctx.useCases.debitWallet.execute(debitCommand());
    expect(replay.outcome).toBe('REPLAYED');
    expect(ctx.wallets.balanceOf(FLEET)).toBe(2_000_000);
    expect(ctx.wallets.writes).toBe(writes);
  });

  it('la misma clave con otros datos es un conflicto (el cliente no redefine el cargo)', async () => {
    await ctx.fund(5_000_000);
    await ctx.useCases.debitWallet.execute(debitCommand());
    await expect(
      ctx.useCases.debitWallet.execute(debitCommand({ energyKwh: 10 })),
    ).rejects.toBeInstanceOf(DebitTermsMismatchError);
  });

  it('la misma petición enviada dos veces a la vez cobra una sola vez', async () => {
    await ctx.fund(5_000_000);
    const results = await Promise.all([
      ctx.useCases.debitWallet.execute(debitCommand()),
      ctx.useCases.debitWallet.execute(debitCommand()),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['DEBITED', 'REPLAYED']);
    expect(ctx.wallets.balanceOf(FLEET)).toBe(2_000_000);
  });

  it('concurrencia: dos débitos con saldo para uno solo → uno cobra, otro 422; nunca negativo', async () => {
    await ctx.fund(DEBIT_AMOUNT + 500_000);
    const results = await Promise.allSettled([
      ctx.useCases.debitWallet.execute(debitCommand()),
      ctx.useCases.debitWallet.execute(
        debitCommand({
          debitId: DEBIT_B,
          sagaId: SAGA_B,
          audit: { correlationId: CORRELATION, idempotencyKey: DEBIT_B },
        }),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(ctx.wallets.balanceOf(FLEET)).toBe(500_000);
  });

  it('atomicidad: si la transacción falla de forma persistente no queda nada aplicado', async () => {
    await ctx.fund(5_000_000);
    ctx.wallets.failNextWrites = 3;
    await expect(ctx.useCases.debitWallet.execute(debitCommand())).rejects.toBeInstanceOf(
      ConcurrentModificationError,
    );
    expect(ctx.wallets.balanceOf(FLEET)).toBe(5_000_000);
    expect(ctx.wallets.debits.has(DEBIT_A)).toBe(false);
    expect(ctx.wallets.ledger.filter((entry) => entry.type === 'DEBIT')).toHaveLength(0);
  });

  it('billetera inexistente → WALLET_NOT_FOUND', async () => {
    await expect(ctx.useCases.debitWallet.execute(debitCommand())).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});

describe('RefundWallet', () => {
  beforeEach(async () => {
    await ctx.fund(5_000_000);
    await ctx.useCases.debitWallet.execute(debitCommand());
  });

  it('reembolso: operación propia (rfd_…) con su movimiento REFUND; saldo restituido', async () => {
    const result = await refund();

    expect(result.outcome).toBe('REFUNDED');
    expect(ctx.wallets.balanceOf(FLEET)).toBe(5_000_000);
    const refundId = DEBIT_A.replace('dbt_', 'rfd_');
    expect(ctx.wallets.refunds.get(refundId)).toMatchObject({
      debitId: DEBIT_A,
      sagaId: SAGA_A,
      reason: 'CHARGER_HARDWARE_FAULT',
      audit: { correlationId: CORRELATION, idempotencyKey: refundId },
    });
    expect(ctx.wallets.ledger.find((entry) => entry.type === 'REFUND')?.operationId).toBe(refundId);
  });

  it('reembolso duplicado: ALREADY_REFUNDED, el saldo no cambia', async () => {
    await refund();
    const second = await refund();
    expect(second.outcome).toBe('ALREADY_REFUNDED');
    expect(ctx.wallets.balanceOf(FLEET)).toBe(5_000_000);
    expect(ctx.wallets.ledger.filter((entry) => entry.type === 'REFUND')).toHaveLength(1);
  });

  it('dos reembolsos simultáneos del mismo débito: solo uno se aplica', async () => {
    const results = await Promise.all([refund(), refund()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['ALREADY_REFUNDED', 'REFUNDED']);
    expect(ctx.wallets.balanceOf(FLEET)).toBe(5_000_000);
    expect(ctx.wallets.ledger.filter((entry) => entry.type === 'REFUND')).toHaveLength(1);
  });

  it('reembolso de un débito inexistente: tombstone (VOIDED) que bloquea el cobro tardío', async () => {
    const result = await refund(DEBIT_B, SAGA_B);
    expect(result.outcome).toBe('VOIDED');

    await expect(
      ctx.useCases.debitWallet.execute(
        debitCommand({
          debitId: DEBIT_B,
          sagaId: SAGA_B,
          audit: { correlationId: CORRELATION, idempotencyKey: DEBIT_B },
        }),
      ),
    ).rejects.toBeInstanceOf(DebitVoidedError);
    expect(ctx.wallets.balanceOf(FLEET)).toBe(2_000_000);
  });

  it('otra SAGA no puede reembolsar el débito (DEBIT_MISMATCH)', async () => {
    await expect(refund(DEBIT_A, SAGA_B)).rejects.toBeInstanceOf(DebitMismatchError);
    expect(ctx.wallets.balanceOf(FLEET)).toBe(2_000_000);
  });

  it('un débito rechazado no tiene nada que reembolsar', async () => {
    const poor = createTestContext();
    await poor.fund(1);
    await expect(poor.useCases.debitWallet.execute(debitCommand())).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    const result = await poor.useCases.refundWallet.execute({
      debitId: DEBIT_A,
      sagaId: SAGA_A,
      reason: 'INSUFFICIENT_FUNDS',
      audit: { correlationId: CORRELATION },
    });
    expect(result.outcome).toBe('NOTHING_TO_REFUND');
    expect(poor.wallets.balanceOf(FLEET)).toBe(1);
  });
});

describe('Consultas y administración', () => {
  it('OpenWallet es idempotente y abre con saldo 0 en la moneda configurada', async () => {
    expect((await ctx.useCases.openWallet.execute(FLEET)).outcome).toBe('CREATED');
    const again = await ctx.useCases.openWallet.execute(FLEET);
    expect(again.outcome).toBe('EXISTING');
    expect(again.wallet.balance).toMatchObject({ amountMinor: 0, currency: 'COP' });
  });

  it('VerifyFunds informa si el saldo cubre el cargo estimado (con surge en hora pico)', async () => {
    await ctx.fund(DEBIT_AMOUNT);
    const check = await ctx.useCases.verifyFunds.execute({
      fleetId: FLEET,
      energyKwh: 30,
      connectorPowerKw: 60,
    });
    expect(check).toMatchObject({ sufficient: true });

    const surge = createTestContext({ surgePricing: true });
    await surge.fund(DEBIT_AMOUNT);
    surge.clock.advance(8.5 * 3_600_000); // 23:30 UTC = 18:30 en Bogotá
    const peak = await surge.useCases.verifyFunds.execute({
      fleetId: FLEET,
      energyKwh: 30,
      connectorPowerKw: 60,
    });
    expect(peak.required.amountMinor).toBe(3_750_000);
    expect(peak.sufficient).toBe(false);
  });

  it('GetTransactionHistory: más reciente primero, paginado y con cursor validado', async () => {
    await ctx.fund(10_000_000);
    ctx.clock.advance(1_000);
    await ctx.useCases.debitWallet.execute(debitCommand());
    ctx.clock.advance(1_000);
    await refund();

    const first = await ctx.useCases.getTransactionHistory.execute({ fleetId: FLEET, limit: 2 });
    expect(first.items.map((entry) => entry.type)).toEqual(['REFUND', 'DEBIT']);
    expect(first.nextCursor).toBeDefined();

    const second = await ctx.useCases.getTransactionHistory.execute({
      fleetId: FLEET,
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    expect(second.items.map((entry) => entry.type)).toEqual(['TOP_UP']);
    expect(second.nextCursor).toBeUndefined();

    await expect(
      ctx.useCases.getTransactionHistory.execute({ fleetId: FLEET, limit: 2, cursor: 'basura' }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('TopUpWallet es idempotente por topUpId', async () => {
    await ctx.useCases.openWallet.execute(FLEET);
    const command = {
      fleetId: FLEET,
      topUpId: 'tup_admin-1',
      amount: { amountMinor: 1_000, currency: 'COP' },
      audit: { correlationId: CORRELATION, idempotencyKey: 'tup_admin-1' },
    };
    expect((await ctx.useCases.topUpWallet.execute(command)).outcome).toBe('APPLIED');
    const replay = await ctx.useCases.topUpWallet.execute(command);
    expect(replay.outcome).toBe('REPLAYED');
    expect(replay.transaction.operationId).toBe('tup_admin-1');
    expect(ctx.wallets.balanceOf(FLEET)).toBe(1_000);
  });
});
