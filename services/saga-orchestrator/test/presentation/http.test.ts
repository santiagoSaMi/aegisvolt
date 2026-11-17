import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sagaOrchestratorV1 } from '@aegisvolt/contracts';
import { createLogger } from '@aegisvolt/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApp } from '../../src/presentation/http/app.ts';
import { FakeParticipants } from '../support/fake-participants.ts';
import { CORRELATION_ID, KEY, SAGA_ID, command, createContext, uuid } from '../support/fixtures.ts';

const silentLogger = createLogger({
  service: 'test',
  environment: 'test',
  version: 'test',
  destination: { write: () => undefined },
});

let server: Server | undefined;

async function start(
  ctx: ReturnType<typeof createContext>,
  syncWaitMs = 2_000,
  logger = silentLogger,
): Promise<string> {
  const app = createHttpApp({
    useCases: ctx,
    readinessCheck: () => Promise.resolve(true),
    logger,
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

describe('GET /v1/audit/sagas (auditoría, ADR-0030)', () => {
  it('lista por estado en todas las flotas, la más antigua primero, con rango temporal y cursor', async () => {
    const ctx = createContext();
    const url = await start(ctx);
    const times: string[] = [];
    for (const [i, fleetId] of ['fleet_001', 'fleet_002', 'fleet_003'].entries()) {
      times.push(ctx.clock.now().toISOString());
      await ctx.reserveAndActivateCharging.execute(
        command({ idempotencyKey: uuid(100 + i), fleetId, connectorId: `cn_0${String(i + 1)}` }),
      );
      ctx.clock.advance(60_000);
    }
    const get = async (query: string) => {
      const response = await fetch(`${url}/v1/audit/sagas?${query}`);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const first = await get('status=COMPLETED&limit=2');
    expect(first.status).toBe(200);
    const page1 = sagaOrchestratorV1.listAuditSagasResponseSchema.parse(first.body);
    expect(page1.items.map((s) => s.fleetId)).toEqual(['fleet_001', 'fleet_002']);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = sagaOrchestratorV1.listAuditSagasResponseSchema.parse(
      (await get(`status=COMPLETED&limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`))
        .body,
    );
    expect(page2.items.map((s) => s.fleetId)).toEqual(['fleet_003']);
    expect(page2.nextCursor).toBeUndefined();

    // updatedBefore excluye la tercera; updatedAfter la incluye sola.
    const before = sagaOrchestratorV1.listAuditSagasResponseSchema.parse(
      (await get(`status=COMPLETED&updatedBefore=${encodeURIComponent(times[2] ?? '')}`)).body,
    );
    expect(before.items).toHaveLength(2);
    const after = sagaOrchestratorV1.listAuditSagasResponseSchema.parse(
      (await get(`status=COMPLETED&updatedAfter=${encodeURIComponent(times[2] ?? '')}`)).body,
    );
    expect(after.items.map((s) => s.fleetId)).toEqual(['fleet_003']);
    expect((await get('status=COMPENSATION_FAILED')).body).toEqual({ items: [] });
  });

  it('valida la consulta: estado obligatorio y conocido, cursor válido', async () => {
    const url = await start(createContext());
    for (const query of [
      '',
      'status=UNKNOWN',
      'status=COMPLETED&limit=0',
      'status=COMPLETED&cursor=xyz',
      'status=COMPLETED&fleetId=fleet_001',
    ]) {
      const response = await fetch(`${url}/v1/audit/sagas?${query}`);
      expect(response.status, query).toBe(400);
    }
  });
});

function captureLogs(): {
  logger: ReturnType<typeof createLogger>;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'saga-orchestrator-service',
    environment: 'test',
    version: 'test',
    destination: {
      write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  return { logger, lines };
}

describe('logs estructurados (ADR-0028)', () => {
  it('cada línea lleva los campos obligatorios, la operación y el correlation_id recibido; los rechazos, un error tipado', async () => {
    const { logger, lines } = captureLogs();
    const url = await start(createContext(), 2_000, logger);

    const response = await fetch(`${url}/v1/sagas/saga_00000000`, {
      headers: { 'x-correlation-id': CORRELATION_ID, authorization: 'Bearer secreto-123' },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toBe(CORRELATION_ID);

    // Ruta inexistente: sin operación nombrada → MÉTODO /ruta.
    await fetch(`${url}/v1/no-existe`, { headers: { 'x-correlation-id': CORRELATION_ID } });
    await vi.waitFor(() => {
      expect(lines.filter((line) => line.event === 'http_request')).toHaveLength(2);
    });

    const rejected = lines.find((line) => line.message === 'Operación rechazada');
    expect(rejected).toMatchObject({
      level: 'warn',
      service_name: 'saga-orchestrator-service',
      environment: 'test',
      correlation_id: CORRELATION_ID,
      operation: 'GetSaga',
      http_status: 404,
    });
    // Error tipado y esperado: tipo, código y mensaje, sin stack.
    const error = (rejected?.error ?? {}) as Record<string, unknown>;
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'type']);
    expect(Object.values(error).every((value) => typeof value === 'string')).toBe(true);
    const requests = lines.filter((line) => line.event === 'http_request');
    expect(requests.map((line) => line.operation)).toEqual(['GetSaga', 'GET /v1/no-existe']);
    expect(requests[0]).toMatchObject({ correlation_id: CORRELATION_ID, http_status: 404 });
    for (const line of lines) {
      for (const field of [
        'timestamp',
        'level',
        'environment',
        'service_name',
        'correlation_id',
        'operation',
        'message',
      ]) {
        expect(line).toHaveProperty(field);
      }
    }
    expect(JSON.stringify(lines)).not.toContain('secreto-123');
  });
});
