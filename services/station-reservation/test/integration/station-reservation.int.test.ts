import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { stationReservationV1 } from '@aegisvolt/contracts';
import { createLogger } from '@aegisvolt/logger';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConcurrentModificationError } from '../../src/application/index.ts';
import { createUseCases } from '../../src/composition.ts';
import {
  ChargingConnector,
  ConnectorId,
  FleetId,
  PowerKw,
  Reservation,
  ReservationId,
  SagaId,
  StationId,
} from '../../src/domain/index.ts';
import { DynamoDbReservationRepository } from '../../src/infrastructure/dynamodb/dynamodb-reservation-repository.ts';
import { createDynamoDbReadinessCheck } from '../../src/infrastructure/dynamodb/readiness.ts';
import { keys } from '../../src/infrastructure/dynamodb/table.ts';
import { StaticFeatureFlagReader } from '../../src/infrastructure/feature-flags/static-feature-flag-reader.ts';
import { createHttpApp } from '../../src/presentation/http/app.ts';
import { FixedClock } from '../support/in-memory-store.ts';
import { START } from '../support/fixtures.ts';
import {
  FLOCI_ENDPOINT,
  createClients,
  createTemporaryTable,
  deleteTable,
  flociAvailable,
} from './floci.ts';

const STATION_ID = 'st_it-norte-01';
const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const sagaId = (n: number) => `saga_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const resId = (n: number) => `res_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!flociAvailable)(
  `station-reservation contra DynamoDB de Floci (${FLOCI_ENDPOINT})`,
  () => {
    const clients = createClients();
    const clock = new FixedClock(START);
    let tableName: string;
    let server: Server;
    let url: string;

    const rawItem = async (key: Record<string, string>) =>
      (
        await clients.documentClient.send(
          new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
        )
      ).Item;
    const rawConnector = (connectorId: string) => rawItem(keys.connector(STATION_ID, connectorId));
    const rawReservation = (reservationId: string) => rawItem(keys.reservation(reservationId));

    const headers = (saga: string) => ({
      'content-type': 'application/json',
      'x-correlation-id': CORRELATION_ID,
      'x-saga-id': saga,
    });
    const hold = (
      reservationId: string,
      saga: string,
      connectorId: string,
      fleetId = 'fleet_001',
    ) =>
      fetch(`${url}/v1/reservations/${reservationId}`, {
        method: 'PUT',
        headers: headers(saga),
        body: JSON.stringify({
          sagaId: saga,
          fleetId,
          stationId: STATION_ID,
          connectorId,
          fastChargeBoost: false,
        }),
      });
    const release = (reservationId: string, saga: string) =>
      fetch(`${url}/v1/reservations/${reservationId}/release`, {
        method: 'POST',
        headers: headers(saga),
        body: JSON.stringify({ reason: 'INSUFFICIENT_FUNDS' }),
      });
    const problemCode = async (response: Response) =>
      stationReservationV1.problemSchema.parse(await response.json()).code;

    beforeAll(async () => {
      tableName = await createTemporaryTable(clients);
      const app = createHttpApp({
        useCases: createUseCases({
          documentClient: clients.documentClient,
          tableName,
          clock,
          flags: new StaticFeatureFlagReader({ ENABLE_FAST_CHARGE_BOOST: false }),
          reservationPolicy: { standardHoldMs: 120_000, boostedHoldMs: 300_000 },
        }),
        readinessCheck: createDynamoDbReadinessCheck(clients.client, tableName, 0),
        logger: createLogger({
          service: 'it',
          environment: 'test',
          version: 'test',
          destination: { write: () => undefined },
        }),
        requestTimeoutMs: 10_000,
      });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const registered = await fetch(`${url}/v1/stations/${STATION_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Estación de integración',
          city: 'bogota',
          location: { latitude: 4.7, longitude: -74.05 },
          connectors: ['cn_01', 'cn_02', 'cn_03', 'cn_04', 'cn_05', 'cn_06'].map((connectorId) => ({
            connectorId,
            type: 'CCS2',
            maxPowerKw: 60,
          })),
        }),
      });
      expect(registered.status).toBe(201);
    });

    afterAll(async () => {
      if (server.listening) {
        server.close();
        await once(server, 'close');
      }
      await deleteTable(clients, tableName);
      clients.client.destroy();
    });

    it('readiness: la tabla existe y está ACTIVE', async () => {
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
      const missing = createDynamoDbReadinessCheck(clients.client, 'aegisvolt-no-existe', 0);
      expect(await missing()).toBe(false);
    });

    it('catálogo: consulta por id (consistente) y por ciudad (GSI1)', async () => {
      const station = stationReservationV1.stationViewSchema.parse(
        await (await fetch(`${url}/v1/stations/${STATION_ID}`)).json(),
      );
      expect(station.connectors).toHaveLength(6);
      const byCity = stationReservationV1.listStationsResponseSchema.parse(
        await (await fetch(`${url}/v1/stations?city=bogota`)).json(),
      );
      expect(byCity.items.map((item) => item.stationId)).toEqual([STATION_ID]);
    });

    it('reserva disponible: reserva HELD y conector RESERVED escritos en la misma transacción', async () => {
      const response = await hold(resId(1), sagaId(1), 'cn_01');
      expect(response.status).toBe(201);

      expect(await rawConnector('cn_01')).toMatchObject({
        status: 'RESERVED',
        holdReservationId: resId(1),
        version: 2,
      });
      expect(await rawReservation(resId(1))).toMatchObject({ status: 'HELD', version: 1 });
    });

    it('reserva duplicada: misma clave y datos → 200; otros datos → 409 IDEMPOTENCY_CONFLICT', async () => {
      const replay = await hold(resId(1), sagaId(1), 'cn_01');
      expect(replay.status).toBe(200);
      expect((await rawConnector('cn_01'))?.version).toBe(2);

      const conflict = await hold(resId(1), sagaId(1), 'cn_01', 'fleet_999');
      expect(conflict.status).toBe(409);
      expect(await problemCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('concurrencia: 8 flotas reservan el mismo conector a la vez y solo una lo obtiene', async () => {
      const attempts = Array.from({ length: 8 }, (_, i) => i + 100);
      const responses = await Promise.all(
        attempts.map((n) => hold(resId(n), sagaId(n), 'cn_02', `fleet_${n}`)),
      );
      const statuses = responses.map((response) => response.status);

      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(7);
      const winner = attempts[statuses.indexOf(201)];
      for (const response of responses.filter((r) => r.status === 409)) {
        expect(await problemCode(response)).toBe('CONNECTOR_UNAVAILABLE');
      }
      expect((await rawConnector('cn_02'))?.holdReservationId).toBe(resId(winner ?? -1));
    });

    it('atomicidad: una escritura con versión obsoleta no deja escrituras parciales', async () => {
      const repository = new DynamoDbReservationRepository(clients.documentClient, tableName);
      const connector = ChargingConnector.create({
        id: ConnectorId.parse('cn_03'),
        stationId: StationId.parse(STATION_ID),
        type: 'CCS2',
        maxPower: PowerKw.of(60),
      });
      const reservation = Reservation.hold({
        id: ReservationId.parse(resId(300)),
        terms: {
          sagaId: SagaId.parse(sagaId(300)),
          fleetId: FleetId.parse('fleet_300'),
          stationId: StationId.parse(STATION_ID),
          connectorId: ConnectorId.parse('cn_03'),
          fastChargeBoost: false,
        },
        holdDurationMs: 60_000,
        now: START,
      });
      const held = connector.placeHold(reservation.id, reservation.holdExpiresAt, START);

      // Versión esperada incorrecta: la transacción entera (conector + reserva) se rechaza.
      await expect(
        repository.saveHold({
          connector: { value: held, expectedVersion: 99 },
          reservation,
          displaced: undefined,
          now: START,
        }),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(await rawReservation(resId(300))).toBeUndefined();
      expect((await rawConnector('cn_03'))?.status).toBe('AVAILABLE');
    });

    it('reserva inexistente: GET → 404 RESERVATION_NOT_FOUND', async () => {
      const response = await fetch(`${url}/v1/reservations/${resId(404)}`);
      expect(response.status).toBe(404);
      expect(await problemCode(response)).toBe('RESERVATION_NOT_FOUND');
    });

    it('liberación inválida (otra SAGA) → 409 y nada cambia; válida → conector AVAILABLE', async () => {
      expect((await hold(resId(4), sagaId(4), 'cn_04')).status).toBe(201);

      const invalid = await release(resId(4), sagaId(999));
      expect(invalid.status).toBe(409);
      expect(await problemCode(invalid)).toBe('RESERVATION_MISMATCH');
      expect((await rawConnector('cn_04'))?.status).toBe('RESERVED');

      const valid = await release(resId(4), sagaId(4));
      expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({ outcome: 'RELEASED', status: 'RELEASED' });

      const connector = await rawConnector('cn_04');
      expect(connector).toMatchObject({ status: 'AVAILABLE', version: 3 });
      expect(connector).not.toHaveProperty('holdReservationId');
      const released = await rawReservation(resId(4));
      expect(released).toMatchObject({ status: 'RELEASED', releaseReason: 'INSUFFICIENT_FUNDS' });
      // TTL de retención: solo en registros terminales, nunca como mecanismo de liberación.
      expect(typeof released?.expiresAtEpoch).toBe('number');

      const again = await release(resId(4), sagaId(4));
      expect(await again.json()).toMatchObject({ outcome: 'ALREADY_RELEASED' });
    });

    it('liberación de una reserva inexistente deja un tombstone que bloquea un PUT tardío', async () => {
      const voided = await release(resId(5), sagaId(5));
      expect(await voided.json()).toMatchObject({ outcome: 'VOIDED', status: 'VOIDED' });
      expect(await rawReservation(resId(5))).toMatchObject({ entity: 'RESERVATION_TOMBSTONE' });

      const late = await hold(resId(5), sagaId(5), 'cn_05');
      expect(late.status).toBe(409);
      expect(await problemCode(late)).toBe('RESERVATION_CANCELLED');
      expect((await rawConnector('cn_05'))?.status).toBe('AVAILABLE');
    });

    it('expiración: el hold vence sin depender del TTL y la reserva vencida queda EXPIRED', async () => {
      expect((await hold(resId(6), sagaId(6), 'cn_06')).status).toBe(201);
      clock.advance(120_000);

      const view = stationReservationV1.reservationViewSchema.parse(
        await (await fetch(`${url}/v1/reservations/${resId(6)}`)).json(),
      );
      expect(view.status).toBe('EXPIRED');

      expect((await hold(resId(7), sagaId(7), 'cn_06', 'fleet_007')).status).toBe(201);
      expect((await rawConnector('cn_06'))?.holdReservationId).toBe(resId(7));
      expect(await rawReservation(resId(6))).toMatchObject({ status: 'EXPIRED', version: 2 });
    });

    it('confirmación: reserva CONFIRMED y conector OCCUPIED', async () => {
      const response = await fetch(`${url}/v1/reservations/${resId(7)}/confirm`, {
        method: 'POST',
        headers: headers(sagaId(7)),
      });
      expect(response.status).toBe(200);
      expect(await rawConnector('cn_06')).toMatchObject({
        status: 'OCCUPIED',
        holdReservationId: resId(7),
      });
      expect(await rawReservation(resId(7))).toMatchObject({ status: 'CONFIRMED' });
    });
  },
);
