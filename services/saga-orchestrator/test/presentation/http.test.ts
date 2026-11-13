import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sagaOrchestratorV1 } from '@aegisvolt/contracts';
import { createLogger } from '@aegisvolt/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpApp } from '../../src/presentation/http/app.ts';
import { FakeParticipants } from '../support/fake-participants.ts';
import { CORRELATION_ID, KEY, SAGA_ID, createContext } from '../support/fixtures.ts';

const silentLogger = createLogger({
  service: 'test',
  environment: 'test',
  version: 'test',
  destination: { write: () => undefined },
});

let server: Server | undefined;

async function start(ctx: ReturnType<typeof createContext>, syncWaitMs = 2_000): Promise<string> {
  const app = createHttpApp({
    useCases: ctx,
    readinessCheck: () => Promise.resolve(true),
    logger: silentLogger,
    requestTimeoutMs: 5_000,
    syncWaitMs,
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server?.listening) {
    server.close();
    await once(server, 'close');
  }
});

const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    fleetId: 'fleet_001',
    stationId: 'st_bog-norte-01',
    connectorId: 'cn_01',
    requestedEnergyKwh: 30,
    ...overrides,
  });
const headers = {
  'content-type': 'application/json',
  'x-correlation-id': CORRELATION_ID,
  'idempotency-key': KEY,
};
const startSaga = (url: string, payload = body(), extra: Record<string, string> = headers) =>
  fetch(`${url}/v1/sagas`, { method: 'POST', headers: extra, body: payload });

describe('POST /v1/sagas', () => {
  it('SAGA terminada → 201 con la vista del contrato; repetición → misma SAGA', async () => {
    const ctx = createContext();
    const url = await start(ctx);

    const first = await startSaga(url);
    const view = (await first.json()) as Record<string, unknown>;

    expect(first.status).toBe(201);
    expect(first.headers.get('location')).toBe(`/v1/sagas/${SAGA_ID}`);
    expect(sagaOrchestratorV1.sagaViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({
      sagaId: SAGA_ID,
      status: 'COMPLETED',
      terminal: true,
      correlationId: CORRELATION_ID,
      reservationId: `res_${KEY}`,
    });

    const again = await startSaga(url);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { sagaId: string }).sagaId).toBe(SAGA_ID);
    expect(ctx.participants.callsTo('debit')).toHaveLength(1);
  });

  it('fondos insuficientes → 201 COMPENSATED con failureReason y pasos', async () => {
    const ctx = createContext({
      participants: new FakeParticipants().respond('debit', {
        kind: 'REJECTED',
        code: 'INSUFFICIENT_FUNDS',
      }),
    });
    const url = await start(ctx);

    const view = (await (await startSaga(url)).json()) as {
      status: string;
      failureReason: string;
      steps: { step: string; status: string }[];
    };

    expect(view.status).toBe('COMPENSATED');
    expect(view.failureReason).toBe('INSUFFICIENT_FUNDS');
    expect(view.steps).toContainEqual(
      expect.objectContaining({ step: 'RELEASE_RESERVATION', status: 'SUCCEEDED' }),
    );
  });

  it('COMPENSATION_FAILED → 202; el reintento controlado → 200 COMPENSATED', async () => {
    const ctx = createContext({
      participants: new FakeParticipants()
        .respond('debit', { kind: 'REJECTED', code: 'INSUFFICIENT_FUNDS' })
        .respond('releaseReservation', { kind: 'REJECTED', code: 'RESERVATION_MISMATCH' }),
    });
    const url = await start(ctx);

    const failed = await startSaga(url);
    expect(failed.status).toBe(202);
    expect(await failed.json()).toMatchObject({
      status: 'COMPENSATION_FAILED',
      terminal: false,
      compensationFailure: { step: 'RELEASE_RESERVATION', errorCode: 'RESERVATION_MISMATCH' },
    });

    const retried = await fetch(`${url}/v1/sagas/${SAGA_ID}/compensation/retry`, {
      method: 'POST',
      headers,
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: 'COMPENSATED' });

    const notRetryable = await fetch(`${url}/v1/sagas/${SAGA_ID}/compensation/retry`, {
      method: 'POST',
      headers,
    });
    expect(notRetryable.status).toBe(409);
    expect(await notRetryable.json()).toMatchObject({ code: 'SAGA_NOT_RETRYABLE' });
  });

  it('misma clave con otro cuerpo → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const url = await start(createContext());
    await startSaga(url);

    const conflict = await startSaga(url, body({ requestedEnergyKwh: 40 }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
  });

  it('exige idempotency-key y x-correlation-id; valida el cuerpo', async () => {
    const url = await start(createContext());
    const withoutKey = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== 'idempotency-key'),
    );
    expect((await startSaga(url, body(), withoutKey)).status).toBe(400);
    expect((await startSaga(url, body({ fleetId: 'x' }))).status).toBe(400);
    expect((await startSaga(url, body({ amount: 1 }))).status).toBe(400);
  });

  it('si la SAGA no termina dentro de la espera → 202 con el estado persistido', async () => {
    const participants = new FakeParticipants();
    const release = participants.block('debit');
    const url = await start(createContext({ participants }), 50);

    const response = await startSaga(url);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      sagaId: SAGA_ID,
      status: 'RESERVATION_COMPLETED',
      terminal: false,
    });
    release();
  });
});

describe('consultas', () => {
  it('GET de la SAGA, su historial y la lista por flota', async () => {
    const ctx = createContext();
    const url = await start(ctx);
    await startSaga(url);

    expect((await fetch(`${url}/v1/sagas/${SAGA_ID}`)).status).toBe(200);
    const events = (await (await fetch(`${url}/v1/sagas/${SAGA_ID}/events`)).json()) as {
      items: unknown[];
    };
    expect(sagaOrchestratorV1.listSagaEventsResponseSchema.safeParse(events).success).toBe(true);
    expect(events.items.length).toBeGreaterThan(5);
    const list = (await (await fetch(`${url}/v1/sagas?fleetId=fleet_001`)).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);
    expect((await fetch(`${url}/v1/sagas/saga_${'0'.repeat(8)}`)).status).toBe(404);
  });
});
