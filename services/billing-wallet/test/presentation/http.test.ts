import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { billingWalletV1 } from '@aegisvolt/contracts';
import { createLogger } from '@aegisvolt/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GetWalletBalance } from '../../src/application/index.ts';
import { createHttpApp, type HttpAppDependencies } from '../../src/presentation/http/app.ts';
import {
  DEBIT_A,
  DEBIT_AMOUNT,
  DEBIT_B,
  FLEET,
  SAGA_A,
  SAGA_B,
  createTestContext,
} from '../support/fixtures.ts';

const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const IDEMPOTENCY_KEY = '9b1d0c2e-4a5f-4c6d-8e7f-0123456789ab';
const silentLogger = createLogger({
  service: 'test',
  environment: 'test',
  version: 'test',
  destination: { write: () => undefined },
});

let server: Server | undefined;
let ctx: ReturnType<typeof createTestContext>;
let url: string;

async function start(overrides: Partial<HttpAppDependencies> = {}): Promise<string> {
  const app = createHttpApp({
    useCases: ctx.useCases,
    readinessCheck: () => Promise.resolve(true),
    logger: silentLogger,
    requestTimeoutMs: 2_000,
    ...overrides,
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sagaHeaders = (sagaId = SAGA_A) => ({
  'content-type': 'application/json',
  'x-correlation-id': CORRELATION_ID,
  'x-saga-id': sagaId,
});
const debitBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    sagaId: SAGA_A,
    fleetId: FLEET,
    energyKwh: 30,
    connectorPowerKw: 60,
    ...overrides,
  });
const putDebit = (debitId = DEBIT_A, sagaId = SAGA_A, body = debitBody()) =>
  fetch(`${url}/v1/debits/${debitId}`, { method: 'PUT', headers: sagaHeaders(sagaId), body });
const refund = (debitId = DEBIT_A, sagaId = SAGA_A) =>
  fetch(`${url}/v1/debits/${debitId}/refund`, {
    method: 'POST',
    headers: sagaHeaders(sagaId),
    body: JSON.stringify({ reason: 'CHARGER_HARDWARE_FAULT' }),
  });

async function problemCode(response: Response): Promise<string> {
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  return billingWalletV1.problemSchema.parse(await response.json()).code;
}

beforeEach(async () => {
  ctx = createTestContext();
  url = await start();
});

afterEach(async () => {
  if (server?.listening) {
    server.close();
    await once(server, 'close');
  }
});

describe('billeteras', () => {
  it('abre (201/200), consulta saldo, recarga y verifica fondos', async () => {
    const open = () => fetch(`${url}/v1/wallets/${FLEET}`, { method: 'PUT' });
    expect((await open()).status).toBe(201);
    expect((await open()).status).toBe(200);

    const topUp = await fetch(`${url}/v1/wallets/${FLEET}/top-ups/tup_admin-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-correlation-id': CORRELATION_ID },
      body: JSON.stringify({ amount: { amountMinor: 5_000_000, currency: 'COP' } }),
    });
    expect(topUp.status).toBe(201);
    const { transaction } = billingWalletV1.topUpResponseSchema.parse(await topUp.json());
    expect(transaction).toMatchObject({ type: 'TOP_UP', correlationId: CORRELATION_ID });

    const wallet = billingWalletV1.walletViewSchema.parse(
      await (await fetch(`${url}/v1/wallets/${FLEET}`)).json(),
    );
    expect(wallet.balance).toEqual({ amountMinor: 5_000_000, currency: 'COP' });

    const funds = billingWalletV1.fundsCheckViewSchema.parse(
      await (
        await fetch(`${url}/v1/wallets/${FLEET}/funds-check?energyKwh=30&connectorPowerKw=60`)
      ).json(),
    );
    expect(funds).toMatchObject({ sufficient: true, required: { amountMinor: DEBIT_AMOUNT } });
  });

  it('el cliente no puede fijar el saldo: PUT de billetera con cuerpo → 400', async () => {
    const response = await fetch(`${url}/v1/wallets/${FLEET}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ balance: { amountMinor: 999_999_999, currency: 'COP' } }),
    });
    expect(response.status).toBe(400);
    expect((await fetch(`${url}/v1/wallets/${FLEET}`)).status).toBe(404);
  });

  it('billetera inexistente → 404 WALLET_NOT_FOUND', async () => {
    const response = await fetch(`${url}/v1/wallets/fleet_nadie`);
    expect(response.status).toBe(404);
    expect(await problemCode(response)).toBe('WALLET_NOT_FOUND');
  });
});

describe('débitos y reembolsos', () => {
  beforeEach(async () => {
    await ctx.fund(5_000_000);
  });

  it('PUT débito: 201; duplicado 200 sin cobrar dos veces; otros datos 409', async () => {
    const created = await putDebit();
    expect(created.status).toBe(201);
    const view = billingWalletV1.debitViewSchema.parse(await created.json());
    expect(view).toMatchObject({ status: 'DEBITED', amount: { amountMinor: DEBIT_AMOUNT } });

    expect((await putDebit()).status).toBe(200);
    expect(ctx.wallets.balanceOf(FLEET)).toBe(5_000_000 - DEBIT_AMOUNT);

    const conflict = await putDebit(DEBIT_A, SAGA_A, debitBody({ energyKwh: 10 }));
    expect(conflict.status).toBe(409);
    expect(await problemCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('el cliente no puede definir el importe: amount en el cuerpo → 400', async () => {
    const response = await putDebit(
      DEBIT_A,
      SAGA_A,
      debitBody({ amount: { amountMinor: 1, currency: 'COP' } }),
    );
    expect(response.status).toBe(400);
    expect(await problemCode(response)).toBe('VALIDATION_ERROR');
  });

  it('POST con idempotency-key: deriva dbt_<clave>, replay 200 y la clave queda registrada', async () => {
    const post = () =>
      fetch(`${url}/v1/debits`, {
        method: 'POST',
        headers: { ...sagaHeaders(), 'idempotency-key': IDEMPOTENCY_KEY },
        body: debitBody(),
      });
    ctx.clock.advance(1_000); // el débito es posterior a la recarga inicial
    const created = await post();
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(`/v1/debits/dbt_${IDEMPOTENCY_KEY}`);
    expect((await post()).status).toBe(200);

    const history = billingWalletV1.listWalletTransactionsResponseSchema.parse(
      await (await fetch(`${url}/v1/wallets/${FLEET}/transactions`)).json(),
    );
    expect(history.items[0]).toMatchObject({
      type: 'DEBIT',
      operationId: `dbt_${IDEMPOTENCY_KEY}`,
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: CORRELATION_ID,
      sagaId: SAGA_A,
    });
  });

  it('fondos insuficientes → 422 INSUFFICIENT_FUNDS', async () => {
    const response = await putDebit(DEBIT_A, SAGA_A, debitBody({ energyKwh: 100 }));
    expect(response.status).toBe(422);
    expect(await problemCode(response)).toBe('INSUFFICIENT_FUNDS');
  });

  it('concurrencia: dos débitos simultáneos con saldo para uno solo → 201 y 422', async () => {
    const tight = createTestContext();
    await tight.fund(DEBIT_AMOUNT);
    server?.close();
    ctx = tight;
    url = await start();

    const responses = await Promise.all([
      putDebit(),
      putDebit(DEBIT_B, SAGA_B, debitBody({ sagaId: SAGA_B })),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(tight.wallets.balanceOf(FLEET)).toBe(0);
  });

  it('reembolso: 200 REFUNDED con refundId; duplicado ALREADY_REFUNDED; otra SAGA 409', async () => {
    await putDebit();

    const mismatch = await refund(DEBIT_A, SAGA_B);
    expect(mismatch.status).toBe(409);
    expect(await problemCode(mismatch)).toBe('DEBIT_MISMATCH');

    const first = billingWalletV1.refundDebitResponseSchema.parse(await (await refund()).json());
    expect(first).toMatchObject({
      outcome: 'REFUNDED',
      status: 'REFUNDED',
      refundId: DEBIT_A.replace('dbt_', 'rfd_'),
    });

    const second = billingWalletV1.refundDebitResponseSchema.parse(await (await refund()).json());
    expect(second.outcome).toBe('ALREADY_REFUNDED');
    expect(ctx.wallets.balanceOf(FLEET)).toBe(5_000_000);
  });

  it('reembolso de un débito inexistente → VOIDED; luego GET y PUT → 409 DEBIT_VOIDED', async () => {
    expect(await (await refund(DEBIT_B, SAGA_B)).json()).toEqual({
      debitId: DEBIT_B,
      status: 'VOIDED',
      outcome: 'VOIDED',
    });
    expect(await problemCode(await fetch(`${url}/v1/debits/${DEBIT_B}`))).toBe('DEBIT_VOIDED');
    expect(await problemCode(await putDebit(DEBIT_B, SAGA_B, debitBody({ sagaId: SAGA_B })))).toBe(
      'DEBIT_VOIDED',
    );
  });

  it('valida cabeceras: x-saga-id obligatorio y coherente con el cuerpo', async () => {
    const missing = await fetch(`${url}/v1/debits/${DEBIT_A}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: debitBody(),
    });
    expect(missing.status).toBe(400);
    expect((await putDebit(DEBIT_A, SAGA_B)).status).toBe(400);
  });
});

describe('robustez', () => {
  it('health y ruta desconocida', async () => {
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    expect(await problemCode(await fetch(`${url}/v1/nada`))).toBe('ROUTE_NOT_FOUND');
  });

  it('timeout → 503 y error inesperado → 500 sin detalles internos', async () => {
    server?.close();
    const hanging = { execute: () => new Promise(() => undefined) } as unknown as GetWalletBalance;
    url = await start({
      useCases: { ...ctx.useCases, getWalletBalance: hanging },
      requestTimeoutMs: 50,
    });
    const timeout = await fetch(`${url}/v1/wallets/${FLEET}`);
    expect(timeout.status).toBe(503);

    server?.close();
    const failing = {
      execute: () => Promise.reject(new Error('secreto interno')),
    } as unknown as GetWalletBalance;
    url = await start({ useCases: { ...ctx.useCases, getWalletBalance: failing } });
    const error = await fetch(`${url}/v1/wallets/${FLEET}`);
    expect(error.status).toBe(500);
    expect(await error.text()).not.toContain('secreto');
  });
});
