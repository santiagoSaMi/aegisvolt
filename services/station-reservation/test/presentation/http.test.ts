import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { stationReservationV1 } from '@aegisvolt/contracts';
import { createLogger } from '@aegisvolt/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GetReservation } from '../../src/application/index.ts';
import { createHttpApp, type HttpAppDependencies } from '../../src/presentation/http/app.ts';
import {
  CONNECTOR_ID,
  RES_A,
  SAGA_A,
  SAGA_B,
  STATION,
  STATION_ID,
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
let ready = true;

async function start(overrides: Partial<HttpAppDependencies> = {}): Promise<string> {
  const app = createHttpApp({
    useCases: ctx.useCases,
    readinessCheck: () => Promise.resolve(ready),
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

const holdBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    sagaId: SAGA_A,
    fleetId: 'fleet_001',
    stationId: STATION_ID,
    connectorId: CONNECTOR_ID,
    fastChargeBoost: false,
    ...overrides,
  });

async function problem(response: Response) {
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  return stationReservationV1.problemSchema.parse(await response.json());
}

beforeEach(async () => {
  ready = true;
  ctx = createTestContext();
  await ctx.useCases.registerStation.execute(STATION);
});

afterEach(async () => {
  if (server?.listening) {
    server.close();
    await once(server, 'close');
  }
});

describe('health', () => {
  it('liveness siempre 200; readiness refleja la dependencia', async () => {
    const url = await start();
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    ready = false;
    const notReady = await fetch(`${url}/health/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: 'not_ready' });
  });
});

describe('reservas', () => {
  it('PUT crea (201), repetir devuelve 200 con la misma reserva y respeta el contrato', async () => {
    const url = await start();
    const put = () =>
      fetch(`${url}/v1/reservations/${RES_A}`, {
        method: 'PUT',
        headers: sagaHeaders(),
        body: holdBody(),
      });

    const created = await put();
    expect(created.status).toBe(201);
    expect(created.headers.get('x-correlation-id')).toBe(CORRELATION_ID);
    const view = stationReservationV1.reservationViewSchema.parse(await created.json());
    expect(view.status).toBe('HELD');

    const replay = await put();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(JSON.parse(JSON.stringify(view)));
  });

  it('GET /v1/reservations?fleetId lista las reservas de la flota; fleetId obligatorio', async () => {
    const url = await start();
    await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: holdBody(),
    });

    const list = await fetch(`${url}/v1/reservations?fleetId=fleet_001`);
    const page = stationReservationV1.listReservationsResponseSchema.parse(await list.json());
    expect(page.items.map((r) => r.reservationId)).toEqual([RES_A]);
    expect((await fetch(`${url}/v1/reservations`)).status).toBe(400);
    expect((await fetch(`${url}/v1/reservations?fleetId=fleet_001&limit=500`)).status).toBe(400);
  });

  it('PUT con el mismo id y otros datos → 409 IDEMPOTENCY_CONFLICT', async () => {
    const url = await start();
    await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: holdBody(),
    });
    const conflict = await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: holdBody({ fleetId: 'fleet_999' }),
    });
    expect(conflict.status).toBe(409);
    expect((await problem(conflict)).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('POST con idempotency-key: 201, reintento 200 y reutilización conflictiva 409', async () => {
    const url = await start();
    const post = (body: string) =>
      fetch(`${url}/v1/reservations`, {
        method: 'POST',
        headers: { ...sagaHeaders(), 'idempotency-key': IDEMPOTENCY_KEY },
        body,
      });

    const created = await post(holdBody());
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(`/v1/reservations/res_${IDEMPOTENCY_KEY}`);
    expect((await post(holdBody())).status).toBe(200);

    const reused = await post(holdBody({ fleetId: 'fleet_002' }));
    expect(reused.status).toBe(409);
    expect((await problem(reused)).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('dos reservas simultáneas del mismo conector: una 201 y otra 409 CONNECTOR_UNAVAILABLE', async () => {
    const url = await start();
    const responses = await Promise.all([
      fetch(`${url}/v1/reservations/${RES_A}`, {
        method: 'PUT',
        headers: sagaHeaders(),
        body: holdBody(),
      }),
      fetch(`${url}/v1/reservations/res_00000000-0000-4000-8000-00000000000b`, {
        method: 'PUT',
        headers: sagaHeaders(SAGA_B),
        body: holdBody({ sagaId: SAGA_B, fleetId: 'fleet_002' }),
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect((await problem(loser!)).code).toBe('CONNECTOR_UNAVAILABLE');
  });

  it('valida cabeceras y cuerpo: x-saga-id obligatorio y coherente, sin campos extra', async () => {
    const url = await start();
    const noSaga = await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-correlation-id': CORRELATION_ID },
      body: holdBody(),
    });
    expect(noSaga.status).toBe(400);

    const mismatch = await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(SAGA_B),
      body: holdBody(),
    });
    const mismatchProblem = await problem(mismatch);
    expect(mismatchProblem.code).toBe('VALIDATION_ERROR');
    expect(mismatchProblem.errors?.[0]?.path).toBe('headers.x-saga-id');

    const extra = await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: holdBody({ holdSeconds: 9999 }),
    });
    expect(extra.status).toBe(400);

    const badJson = await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: '{no-json',
    });
    expect((await problem(badJson)).code).toBe('VALIDATION_ERROR');
  });

  it('GET de una reserva inexistente → 404 RESERVATION_NOT_FOUND con correlationId', async () => {
    const url = await start();
    const response = await fetch(`${url}/v1/reservations/${RES_A}`, {
      headers: { 'x-correlation-id': CORRELATION_ID },
    });
    expect(response.status).toBe(404);
    expect(await problem(response)).toMatchObject({
      code: 'RESERVATION_NOT_FOUND',
      correlationId: CORRELATION_ID,
    });
  });

  it('release válido (200 RELEASED) e inválido de otra SAGA (409 RESERVATION_MISMATCH)', async () => {
    const url = await start();
    await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: holdBody(),
    });
    const release = (sagaId: string) =>
      fetch(`${url}/v1/reservations/${RES_A}/release`, {
        method: 'POST',
        headers: sagaHeaders(sagaId),
        body: JSON.stringify({ reason: 'INSUFFICIENT_FUNDS' }),
      });

    const invalid = await release(SAGA_B);
    expect(invalid.status).toBe(409);
    expect((await problem(invalid)).code).toBe('RESERVATION_MISMATCH');

    const valid = await release(SAGA_A);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      reservationId: RES_A,
      status: 'RELEASED',
      outcome: 'RELEASED',
    });
  });

  it('confirm deja el conector OCCUPIED (visible en la estación)', async () => {
    const url = await start();
    await fetch(`${url}/v1/reservations/${RES_A}`, {
      method: 'PUT',
      headers: sagaHeaders(),
      body: holdBody(),
    });
    const confirmed = await fetch(`${url}/v1/reservations/${RES_A}/confirm`, {
      method: 'POST',
      headers: sagaHeaders(),
    });
    expect(confirmed.status).toBe(200);

    const station = stationReservationV1.stationViewSchema.parse(
      await (await fetch(`${url}/v1/stations/${STATION_ID}`)).json(),
    );
    expect(station.connectors.find((c) => c.connectorId === CONNECTOR_ID)?.status).toBe('OCCUPIED');
  });
});

describe('estaciones y disponibilidad', () => {
  it('registra (201/200/409), lista por ciudad y consulta disponibles', async () => {
    const url = await start();
    const body = JSON.stringify({
      name: 'Electrolinera Sur',
      city: 'bogota',
      location: { latitude: 4.6, longitude: -74.1 },
      connectors: [{ connectorId: 'cn_01', type: 'TYPE2', maxPowerKw: 22 }],
    });
    const put = (payload: string) =>
      fetch(`${url}/v1/stations/st_bog-sur-01`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
    expect((await put(body)).status).toBe(201);
    expect((await put(body)).status).toBe(200);
    const conflict = await put(body.replace('Electrolinera Sur', 'Otra'));
    expect((await problem(conflict)).code).toBe('STATION_ALREADY_EXISTS');

    const list = stationReservationV1.listStationsResponseSchema.parse(
      await (await fetch(`${url}/v1/stations?city=bogota`)).json(),
    );
    expect(list.items.map((station) => station.stationId)).toEqual([STATION_ID, 'st_bog-sur-01']);

    const available = stationReservationV1.listAvailableConnectorsResponseSchema.parse(
      await (await fetch(`${url}/v1/connectors/available?city=bogota`)).json(),
    );
    expect(available.items).toHaveLength(3);
    expect((await fetch(`${url}/v1/connectors/available`)).status).toBe(400);
    expect((await fetch(`${url}/v1/stations`)).status).toBe(400);
  });

  it('estación inexistente → 404 STATION_NOT_FOUND; ruta desconocida → 404 ROUTE_NOT_FOUND', async () => {
    const url = await start();
    expect((await problem(await fetch(`${url}/v1/stations/st_nada`))).code).toBe(
      'STATION_NOT_FOUND',
    );
    expect((await problem(await fetch(`${url}/v1/nada`))).code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('timeouts y errores', () => {
  it('una petición que excede el presupuesto responde 503 SERVICE_UNAVAILABLE', async () => {
    const hanging = { execute: () => new Promise(() => undefined) } as unknown as GetReservation;
    const url = await start({
      useCases: { ...ctx.useCases, getReservation: hanging },
      requestTimeoutMs: 50,
    });
    const response = await fetch(`${url}/v1/reservations/${RES_A}`);
    expect(response.status).toBe(503);
    expect((await problem(response)).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('un error inesperado → 500 INTERNAL_ERROR sin detalles internos', async () => {
    const failing = {
      execute: () => Promise.reject(new Error('secreto interno')),
    } as unknown as GetReservation;
    const url = await start({ useCases: { ...ctx.useCases, getReservation: failing } });
    const response = await fetch(`${url}/v1/reservations/${RES_A}`);
    const body = await problem(response);
    expect(body).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', detail: 'Error interno' });
    expect(JSON.stringify(body)).not.toContain('secreto');
  });
});
