import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { energyDispatchV1 } from '@aegisvolt/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GetChargingSession } from '../../src/application/index.ts';
import { SimulatedChargerAdapter } from '../../src/infrastructure/charger/simulated-charger-adapter.ts';
import { createHttpApp, type HttpAppDependencies } from '../../src/presentation/http/app.ts';
import { InMemoryFlags } from '../support/fakes.ts';
import {
  CONNECTOR,
  SAGA_A,
  SAGA_B,
  SESSION_A,
  SESSION_B,
  STATION,
  START,
  capturingLogger,
  createTestContext,
} from '../support/fixtures.ts';

const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';

let server: Server | undefined;
let flags: InMemoryFlags;
let ctx: ReturnType<typeof createTestContext<SimulatedChargerAdapter>>;
let url: string;

async function start(overrides: Partial<HttpAppDependencies> = {}): Promise<string> {
  const { logger } = capturingLogger();
  const app = createHttpApp({
    useCases: ctx.useCases,
    readinessCheck: () => Promise.resolve(true),
    logger,
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
const activationBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    sagaId: SAGA_A,
    stationId: STATION,
    connectorId: CONNECTOR,
    energyKwh: 30,
    ...overrides,
  });
const putSession = (sessionId = SESSION_A, sagaId = SAGA_A, body = activationBody()) =>
  fetch(`${url}/v1/sessions/${sessionId}`, {
    method: 'PUT',
    headers: sagaHeaders(sagaId),
    body,
  });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const telemetry = (
  offsetMs: number,
  energyKwh: number,
  overrides: Record<string, unknown> = {},
) => ({
  timestamp: new Date(START.getTime() + offsetMs).toISOString(),
  voltageV: 400,
  currentA: 145,
  powerKw: 58,
  energyKwh,
  ...overrides,
});

beforeEach(async () => {
  flags = new InMemoryFlags();
  const captured = capturingLogger();
  ctx = createTestContext(new SimulatedChargerAdapter({ flags, logger: captured.logger }));
  url = await start();
});

afterEach(async () => {
  if (server?.listening) {
    server.close();
    await once(server, 'close');
  }
});

describe('PUT /v1/sessions/{sessionId} (activación)', () => {
  it('inicio correcto → 201 con la vista del contrato; repetición → 200 idéntica', async () => {
    const first = await putSession();
    const body = (await first.json()) as Record<string, unknown>;

    expect(first.status).toBe(201);
    expect(first.headers.get('x-correlation-id')).toBe(CORRELATION_ID);
    expect(energyDispatchV1.sessionViewSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ sessionId: SESSION_A, status: 'ACTIVE', requestedEnergyKwh: 30 });

    const replay = await putSession();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
  });

  it('sesión duplicada con otros términos → 409 IDEMPOTENCY_CONFLICT', async () => {
    await putSession();
    const response = await putSession(SESSION_A, SAGA_A, activationBody({ energyKwh: 40 }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('conector ocupado por otra sesión → 409 CONNECTOR_BUSY', async () => {
    await putSession();
    const response = await putSession(SESSION_B, SAGA_B, activationBody({ sagaId: SAGA_B }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CONNECTOR_BUSY' });
  });

  it('fallo inducido por la flag → 422 CHARGER_HARDWARE_FAULT con faultCode y simulated', async () => {
    flags.set('SIMULATE_CHARGER_HARDWARE_FAULT', true);

    const response = await putSession();
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(energyDispatchV1.chargerFaultProblemSchema.safeParse(problem).success).toBe(true);
    expect(problem).toMatchObject({
      code: 'CHARGER_HARDWARE_FAULT',
      faultCode: 'E-HW-001',
      simulated: true,
      sessionId: SESSION_A,
      correlationId: CORRELATION_ID,
    });
    // La sesión FAILED queda registrada y consultable (el orquestador la verifica).
    const session = await fetch(`${url}/v1/sessions/${SESSION_A}`);
    expect(await session.json()).toMatchObject({
      status: 'FAILED',
      fault: { code: 'E-HW-001', simulated: true },
    });
  });

  it('fallo técnico del cargador → 503 CHARGER_UNAVAILABLE sin detalles internos', async () => {
    ctx.charger.startCharging = () => Promise.reject(new Error('socket hang up'));
    const generic = await putSession();
    expect(generic.status).toBe(500);
    expect(JSON.stringify(await generic.json())).not.toContain('socket');

    const { ChargerUnavailableError } = await import('../../src/application/index.ts');
    ctx.charger.startCharging = () =>
      Promise.reject(new ChargerUnavailableError('timeout con 10.0.0.12:9000'));
    const unavailable = await putSession();
    const problem = (await unavailable.json()) as Record<string, unknown>;
    expect(unavailable.status).toBe(503);
    expect(problem.code).toBe('CHARGER_UNAVAILABLE');
    expect(problem.detail).toBeUndefined();
  });

  it('valida el cuerpo, las cabeceras de la SAGA y su coherencia', async () => {
    const extra = await putSession(SESSION_A, SAGA_A, activationBody({ status: 'ACTIVE' }));
    expect(extra.status).toBe(400);

    const mismatch = await putSession(SESSION_A, SAGA_B);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      errors: [{ path: 'headers.x-saga-id', message: 'Debe coincidir con body.sagaId' }],
    });

    const badId = await putSession('ses_INVALID');
    expect(badId.status).toBe(400);

    const malformed = await fetch(`${url}/v1/sessions/${SESSION_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: '{',
    });
    expect(malformed.status).toBe(400);
  });
});

describe('POST /v1/sessions/{id}/stop y /abort', () => {
  it('parada → 200 STOPPED y repetirla → 200 ALREADY_STOPPED', async () => {
    await putSession();
    const first = await post(`/v1/sessions/${SESSION_A}/stop`, { reason: 'USER_REQUEST' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      sessionId: SESSION_A,
      status: 'COMPLETED',
      outcome: 'STOPPED',
    });

    const again = await fetch(`${url}/v1/sessions/${SESSION_A}/stop`, { method: 'POST' });
    expect(await again.json()).toMatchObject({ outcome: 'ALREADY_STOPPED' });

    const view = (await (await fetch(`${url}/v1/sessions/${SESSION_A}`)).json()) as {
      transitions: { to: string }[];
      stopReason: string;
    };
    expect(view.stopReason).toBe('USER_REQUEST');
    expect(view.transitions.map((t) => t.to)).toEqual(['ACTIVE', 'COMPLETED']);
  });

  it('parar una sesión inexistente → 404; motivo inválido → 400', async () => {
    expect((await post(`/v1/sessions/${SESSION_A}/stop`, {})).status).toBe(404);
    await putSession();
    expect((await post(`/v1/sessions/${SESSION_A}/stop`, { reason: 'BOOM' })).status).toBe(400);
  });

  it('aborto (compensación) dos veces → ABORTED y ALREADY_ABORTED; sin sesión → VOIDED', async () => {
    await putSession();
    const headers = sagaHeaders();
    const body = { reason: 'INSUFFICIENT_FUNDS' };
    expect(await (await post(`/v1/sessions/${SESSION_A}/abort`, body, headers)).json()).toEqual({
      sessionId: SESSION_A,
      status: 'ABORTED',
      outcome: 'ABORTED',
    });
    expect(
      await (await post(`/v1/sessions/${SESSION_A}/abort`, body, headers)).json(),
    ).toMatchObject({ outcome: 'ALREADY_ABORTED' });
    expect(
      await (await post(`/v1/sessions/${SESSION_B}/abort`, body, sagaHeaders(SAGA_B))).json(),
    ).toEqual({ sessionId: SESSION_B, status: 'VOIDED', outcome: 'VOIDED' });
    // Activación tardía tras el tombstone.
    const late = await putSession(SESSION_B, SAGA_B, activationBody({ sagaId: SAGA_B }));
    expect(await late.json()).toMatchObject({ code: 'SESSION_ABORTED' });
  });
});

describe('Telemetría', () => {
  it('registra (201), repite (200) y lista la más reciente primero', async () => {
    await putSession();
    const path = `/v1/sessions/${SESSION_A}/telemetry`;

    const created = await post(path, telemetry(10_000, 1));
    expect(created.status).toBe(201);
    const view = await created.json();
    expect(energyDispatchV1.telemetryRecordViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ sessionId: SESSION_A, voltageV: 400, currentA: 145 });

    expect((await post(path, telemetry(10_000, 1))).status).toBe(200);
    await post(path, telemetry(20_000, 2));

    const list = (await (await fetch(`${url}${path}?limit=5`)).json()) as {
      items: { energyKwh: number }[];
    };
    expect(list.items.map((item) => item.energyKwh)).toEqual([2, 1]);
    const session = await (await fetch(`${url}/v1/sessions/${SESSION_A}`)).json();
    expect(session).toMatchObject({ energyDeliveredKwh: 2 });
  });

  it('telemetría inválida → 400 (esquema, campos mínimos o incoherencia física)', async () => {
    await putSession();
    const path = `/v1/sessions/${SESSION_A}/telemetry`;
    const withoutCurrent = Object.fromEntries(
      Object.entries(telemetry(10_000, 1)).filter(([key]) => key !== 'currentA'),
    );

    const cases = [
      withoutCurrent,
      telemetry(10_000, 1, { voltageV: 'alto' }),
      telemetry(10_000, 1, { temperatureC: 300 }),
      telemetry(10_000, 1, { powerKw: 150 }),
      telemetry(10_000, 1, { sessionId: SESSION_B }),
    ];
    for (const body of cases) {
      const response = await post(path, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(ctx.sessions.telemetry.size).toBe(0);
  });

  it('fuera de orden → 409 TELEMETRY_OUT_OF_ORDER; sesión terminada → 409 SESSION_NOT_ACTIVE', async () => {
    await putSession();
    const path = `/v1/sessions/${SESSION_A}/telemetry`;
    await post(path, telemetry(20_000, 2));

    expect(await (await post(path, telemetry(10_000, 1))).json()).toMatchObject({
      code: 'TELEMETRY_OUT_OF_ORDER',
    });
    await post(`/v1/sessions/${SESSION_A}/stop`, {});
    expect(await (await post(path, telemetry(30_000, 3))).json()).toMatchObject({
      code: 'SESSION_NOT_ACTIVE',
    });
  });
});

describe('Consultas por estación y cargador', () => {
  it('estado del cargador y sesiones activas', async () => {
    const charger = `/v1/stations/${STATION}/connectors/${CONNECTOR}/charger`;
    expect(await (await fetch(`${url}${charger}`)).json()).toMatchObject({ state: 'IDLE' });

    await putSession();
    const status = await (await fetch(`${url}${charger}`)).json();
    expect(energyDispatchV1.chargerStatusViewSchema.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({ state: 'CHARGING', activeSessionId: SESSION_A });

    const active = (await (
      await fetch(`${url}/v1/stations/${STATION}/sessions?active=true`)
    ).json()) as { items: { sessionId: string }[] };
    expect(active.items.map((s) => s.sessionId)).toEqual([SESSION_A]);

    flags.set('SIMULATE_CHARGER_HARDWARE_FAULT', true);
    expect(await (await fetch(`${url}${charger}`)).json()).toMatchObject({
      state: 'FAULTED',
      fault: { code: 'E-HW-001', simulated: true },
    });
  });
});

describe('Errores comunes y probes', () => {
  it('sesión inexistente → 404 SESSION_NOT_FOUND; ruta desconocida → 404 ROUTE_NOT_FOUND', async () => {
    expect(await (await fetch(`${url}/v1/sessions/${SESSION_A}`)).json()).toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    expect(await (await fetch(`${url}/v1/nada`)).json()).toMatchObject({
      code: 'ROUTE_NOT_FOUND',
    });
  });

  it('timeout → 503 SERVICE_UNAVAILABLE', async () => {
    server?.close();
    const slow = {
      execute: () => new Promise(() => undefined),
    } as unknown as GetChargingSession;
    url = await start({
      useCases: { ...ctx.useCases, getChargingSession: slow },
      requestTimeoutMs: 100,
    });

    const response = await fetch(`${url}/v1/sessions/${SESSION_A}`);
    expect(response.status).toBe(503);
  });

  it('liveness y readiness', async () => {
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    server?.close();
    url = await start({ readinessCheck: () => Promise.resolve(false) });
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
  });
});
