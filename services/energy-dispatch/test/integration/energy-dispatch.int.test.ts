import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { energyDispatchV1 } from '@aegisvolt/contracts';
import { DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConcurrentModificationError } from '../../src/application/index.ts';
import { createUseCases } from '../../src/composition.ts';
import { SessionId } from '../../src/domain/index.ts';
import { SimulatedChargerAdapter } from '../../src/infrastructure/charger/simulated-charger-adapter.ts';
import { DynamoDbSessionRepository } from '../../src/infrastructure/dynamodb/dynamodb-session-repository.ts';
import { createDynamoDbReadinessCheck } from '../../src/infrastructure/dynamodb/readiness.ts';
import { keys } from '../../src/infrastructure/dynamodb/table.ts';
import { createFeatureFlagReader } from '../../src/infrastructure/feature-flags/feature-flag-reader.ts';
import { createHttpApp } from '../../src/presentation/http/app.ts';
import { FixedClock } from '../support/fakes.ts';
import { START, capturingLogger, uuid } from '../support/fixtures.ts';
import {
  FLOCI_ENDPOINT,
  createClients,
  createTemporaryFlagsTable,
  createTemporaryTable,
  deleteTable,
  flociAvailable,
  setFlag,
} from './floci.ts';

const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const STATION = 'st_bog-it-01';
const sagaId = (n: number) => `saga_${uuid(n)}`;
const sessionId = (n: number) => `ses_${uuid(n)}`;
const connector = (n: number) => `cn_${String(n).padStart(2, '0')}`;

describe.skipIf(!flociAvailable)(
  `energy-dispatch contra DynamoDB de Floci (${FLOCI_ENDPOINT})`,
  () => {
    const clients = createClients();
    const clock = new FixedClock(START);
    const { logger, lines } = capturingLogger();
    let tableName: string;
    let flagsTable: string;
    let flagVersion = 0;
    let server: Server;
    let url: string;

    const raw = async (key: { PK: string; SK: string }) =>
      (
        await clients.documentClient.send(
          new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
        )
      ).Item as Record<string, unknown> | undefined;

    const headers = (n: number) => ({
      'content-type': 'application/json',
      'x-correlation-id': CORRELATION_ID,
      'x-saga-id': sagaId(n),
    });
    const activate = (n: number, cn = connector(n), energyKwh = 30) =>
      fetch(`${url}/v1/sessions/${sessionId(n)}`, {
        method: 'PUT',
        headers: headers(n),
        body: JSON.stringify({ sagaId: sagaId(n), stationId: STATION, connectorId: cn, energyKwh }),
      });
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body),
      });
    const telemetry = (offsetMs: number, energyKwh: number, powerKw = 58) => ({
      timestamp: new Date(START.getTime() + offsetMs).toISOString(),
      voltageV: 400,
      currentA: 145,
      powerKw,
      energyKwh,
    });
    const simulateFault = (enabled: boolean) =>
      setFlag(clients, flagsTable, 'SIMULATE_CHARGER_HARDWARE_FAULT', enabled, ++flagVersion);

    beforeAll(async () => {
      [tableName, flagsTable] = await Promise.all([
        createTemporaryTable(clients),
        createTemporaryFlagsTable(clients),
      ]);
      await simulateFault(false);
      // TTL 0: cada activación lee la tabla de flags (se observa el cambio al instante).
      const flags = createFeatureFlagReader({
        documentClient: clients.documentClient,
        tableName: flagsTable,
        cacheTtlMs: 0,
        logger,
      });
      const app = createHttpApp({
        useCases: createUseCases({
          documentClient: clients.documentClient,
          tableName,
          telemetryRetentionDays: 30,
          charger: new SimulatedChargerAdapter({ flags, logger }),
          clock,
        }),
        readinessCheck: createDynamoDbReadinessCheck(clients.client, tableName),
        logger,
        requestTimeoutMs: 10_000,
      });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.close();
      await Promise.allSettled([
        deleteTable(clients, tableName),
        clients.client.send(new DeleteTableCommand({ TableName: flagsTable })),
      ]);
      clients.client.destroy();
    });

    it('readiness con la tabla ACTIVE', async () => {
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    });

    it('inicio correcto: sesión, ocupación del conector e índice de activas en DynamoDB', async () => {
      const response = await activate(1);
      expect(response.status).toBe(201);
      expect(energyDispatchV1.sessionViewSchema.safeParse(await response.json()).success).toBe(
        true,
      );

      expect(await raw(keys.session(sessionId(1)))).toMatchObject({
        status: 'ACTIVE',
        version: 1,
        requestedWh: 30_000,
        GSI1PK: `STATION#${STATION}`,
        GSI2PK: `ACTIVE#${STATION}`,
      });
      expect(await raw(keys.connector(STATION, connector(1)))).toMatchObject({
        activeSessionId: sessionId(1),
      });
    });

    it('sesión duplicada: 200 con la misma vista y sin reescribir', async () => {
      const replay = await activate(1);
      expect(replay.status).toBe(200);
      expect((await raw(keys.session(sessionId(1))))?.version).toBe(1);
    });

    it('fallo inducido por la flag leída de la tabla de flags del ambiente', async () => {
      await simulateFault(true);
      const failed = await activate(2);
      expect(failed.status).toBe(422);
      expect(await failed.json()).toMatchObject({
        code: 'CHARGER_HARDWARE_FAULT',
        faultCode: 'E-HW-001',
        simulated: true,
        sessionId: sessionId(2),
      });
      expect(await raw(keys.session(sessionId(2)))).toMatchObject({
        status: 'FAILED',
        faultCode: 'E-HW-001',
        faultSimulated: true,
      });
      expect(await raw(keys.connector(STATION, connector(2)))).toBeUndefined();
      expect((await raw(keys.session(sessionId(2))))?.GSI2PK).toBeUndefined();
      expect(lines).toContainEqual(
        expect.objectContaining({ event: 'charger_fault', session_id: sessionId(2) }),
      );

      // Cambiar la flag en el almacén cambia el comportamiento sin reiniciar.
      await simulateFault(false);
      expect((await activate(3)).status).toBe(201);
    });

    it('activaciones simultáneas en el mismo conector: 1 sesión, el resto CONNECTOR_BUSY', async () => {
      const cn = connector(10);
      const responses = await Promise.all([11, 12, 13, 14, 15, 16].map((n) => activate(n, cn)));
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      const winner = await raw(keys.connector(STATION, cn));
      const active = await Promise.all(
        [11, 12, 13, 14, 15, 16].map(async (n) => (await raw(keys.session(sessionId(n))))?.status),
      );
      expect(active.filter((s) => s === 'ACTIVE')).toHaveLength(1);
      expect(active.filter((s) => s === undefined)).toHaveLength(5);
      expect(String(winner?.activeSessionId)).toMatch(/^ses_/);
    });

    it('activaciones simultáneas del mismo id: 1 × 201 y el resto 200', async () => {
      const statuses = (await Promise.all([20, 20, 20, 20].map((n) => activate(n)))).map(
        (r) => r.status,
      );
      expect(statuses.sort()).toEqual([200, 200, 200, 201]);
    });

    it('telemetría: registro, repetición idempotente, inválida y fuera de orden', async () => {
      const path = `/v1/sessions/${sessionId(1)}/telemetry`;
      expect((await post(path, telemetry(10_000, 1))).status).toBe(201);
      expect((await post(path, telemetry(10_000, 1))).status).toBe(200);
      expect((await post(path, telemetry(20_000, 2, 150))).status).toBe(400);
      expect((await post(path, telemetry(30_000, 3))).status).toBe(201);
      expect(await (await post(path, telemetry(25_000, 3))).json()).toMatchObject({
        code: 'TELEMETRY_OUT_OF_ORDER',
      });

      const item = await raw(keys.telemetry(sessionId(1), telemetry(10_000, 1).timestamp));
      expect(item).toMatchObject({ voltageV: 400, currentA: 145, powerKw: 58, energyKwh: 1 });
      expect(typeof item?.ttl).toBe('number');
      expect(
        await raw(keys.telemetry(sessionId(1), telemetry(20_000, 2).timestamp)),
      ).toBeUndefined();

      const list = (await (await fetch(`${url}${path}`)).json()) as {
        items: { energyKwh: number }[];
      };
      expect(list.items.map((i) => i.energyKwh)).toEqual([3, 1]);
      expect(await raw(keys.session(sessionId(1)))).toMatchObject({ lastEnergyKwh: 3, version: 3 });
    });

    it('sesiones activas (GSI2 sparse) e históricas (GSI1) con paginación', async () => {
      const active = (await (
        await fetch(`${url}/v1/stations/${STATION}/sessions?active=true&limit=50`)
      ).json()) as { items: { sessionId: string }[] };
      expect(active.items.map((s) => s.sessionId)).toContain(sessionId(1));
      expect(active.items.map((s) => s.sessionId)).not.toContain(sessionId(2));

      const firstPage = (await (
        await fetch(`${url}/v1/stations/${STATION}/sessions?limit=2`)
      ).json()) as { items: unknown[]; nextCursor?: string };
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).toBeDefined();
      const second = await fetch(
        `${url}/v1/stations/${STATION}/sessions?limit=2&cursor=${firstPage.nextCursor ?? ''}`,
      );
      expect(second.status).toBe(200);
      const forged = await fetch(
        `${url}/v1/stations/st_otra/sessions?cursor=${firstPage.nextCursor ?? ''}`,
      );
      expect(forged.status).toBe(400);
    });

    it('parada: COMPLETED, conector liberado, fuera del índice de activas; repetirla no escribe', async () => {
      const stop = await post(`/v1/sessions/${sessionId(1)}/stop`, { reason: 'TARGET_REACHED' });
      expect(await stop.json()).toMatchObject({ status: 'COMPLETED', outcome: 'STOPPED' });

      const item = await raw(keys.session(sessionId(1)));
      expect(item).toMatchObject({ status: 'COMPLETED', stopReason: 'TARGET_REACHED', version: 4 });
      expect(item?.GSI2PK).toBeUndefined();
      expect(item?.transitions).toHaveLength(2);
      expect(await raw(keys.connector(STATION, connector(1)))).toBeUndefined();

      const again = await post(`/v1/sessions/${sessionId(1)}/stop`, {});
      expect(await again.json()).toMatchObject({ outcome: 'ALREADY_STOPPED' });
      expect((await raw(keys.session(sessionId(1))))?.version).toBe(4);
    });

    it('compensación procesada dos veces y tombstone que bloquea la activación tardía', async () => {
      const body = { reason: 'INSUFFICIENT_FUNDS' };
      const first = await post(`/v1/sessions/${sessionId(3)}/abort`, body, headers(3));
      const second = await post(`/v1/sessions/${sessionId(3)}/abort`, body, headers(3));
      expect(await first.json()).toMatchObject({ outcome: 'ABORTED' });
      expect(await second.json()).toMatchObject({ outcome: 'ALREADY_ABORTED' });
      expect((await raw(keys.session(sessionId(3))))?.version).toBe(2);
      expect(await raw(keys.connector(STATION, connector(3)))).toBeUndefined();

      const voided = await post(`/v1/sessions/${sessionId(30)}/abort`, body, headers(30));
      expect(await voided.json()).toMatchObject({ outcome: 'VOIDED' });
      const late = await activate(30);
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ code: 'SESSION_ABORTED' });
    });

    it('atomicidad: una versión obsoleta no escribe nada (ni sesión ni conector)', async () => {
      expect((await activate(40)).status).toBe(201);
      const repository = new DynamoDbSessionRepository(clients.documentClient, tableName);
      const stored = await repository.findSession(SessionId.parse(sessionId(40)));
      if (stored?.kind !== 'SESSION') {
        throw new Error('sesión esperada');
      }
      const { session } = stored.session.value.stop('USER_REQUEST', START);

      await expect(
        repository.saveEnded({ session, expectedVersion: stored.session.version + 7 }),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect((await raw(keys.session(sessionId(40))))?.status).toBe('ACTIVE');
      expect((await raw(keys.connector(STATION, connector(40))))?.activeSessionId).toBe(
        sessionId(40),
      );
    });
  },
);
