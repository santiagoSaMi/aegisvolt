import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collect, save } from '../src/evidence.ts';
import { E2E_USERS, EVIDENCE_DIR, FLOCI_ENDPOINT, Stack, flociAvailable } from '../src/stack.ts';

const available = await flociAvailable();
if (!available && process.env.REQUIRE_INTEGRATION === 'true') {
  throw new Error(`Floci no responde en ${FLOCI_ENDPOINT} y REQUIRE_INTEGRATION=true`);
}

const STATION = 'st_gql-norte-01';
const ALFA = E2E_USERS.operatorAlfa.fleetId;
const BETA = E2E_USERS.operatorBeta.fleetId;

interface GraphqlResult<T = Record<string, unknown>> {
  data?: T | null;
  errors?: {
    message: string;
    extensions?: { code?: string; reason?: string; correlationId?: string };
  }[];
}

describe.skipIf(!available)(`GraphQL API de punta a punta (Floci ${FLOCI_ENDPOINT})`, () => {
  const stack = new Stack();
  const tokens: Record<'admin' | 'alfa' | 'beta', string> = { admin: '', alfa: '', beta: '' };

  /** Petición GraphQL real: HTTP → graphql-api (JWT de Cognito) → servicios → DynamoDB. */
  async function gql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
    options: { token?: string | null; correlationId?: string } = {},
  ): Promise<{ status: number; correlationId: string | null; body: GraphqlResult<T> }> {
    const token = options.token === undefined ? tokens.alfa : options.token;
    const response = await fetch(`${stack.url('graphql-api')}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(options.correlationId === undefined
          ? {}
          : { 'x-correlation-id': options.correlationId }),
      },
      body: JSON.stringify({ query, variables }),
    });
    return {
      status: response.status,
      correlationId: response.headers.get('x-correlation-id'),
      body: (await response.json()) as GraphqlResult<T>,
    };
  }

  const reserve = `mutation($input: ReserveAndActivateChargingInput!) {
    reserveAndActivateCharging(input: $input) {
      finished
      saga { sagaId status failureReason correlationId reservationId sessionId debitId }
    }
  }`;

  beforeAll(async () => {
    await stack.up();
    const station = await fetch(`${stack.url('station-reservation')}/v1/stations/${STATION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Estación GraphQL Norte',
        city: 'medellin',
        location: { latitude: 6.25, longitude: -75.56 },
        connectors: ['cn_01', 'cn_02', 'cn_03'].map((connectorId) => ({
          connectorId,
          type: 'CCS2',
          maxPowerKw: 60,
        })),
      }),
    });
    expect(station.status).toBe(201);
    for (const fleetId of [ALFA, BETA]) {
      const wallets = `${stack.url('billing-wallet')}/v1/wallets/${fleetId}`;
      await fetch(wallets, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await fetch(`${wallets}/top-ups/tup_${randomUUID()}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: { amountMinor: 20_000_000, currency: 'COP' } }),
      });
    }
    tokens.admin = await stack.cognito.idToken(E2E_USERS.admin.username);
    tokens.alfa = await stack.cognito.idToken(E2E_USERS.operatorAlfa.username);
    tokens.beta = await stack.cognito.idToken(E2E_USERS.operatorBeta.username);
  });

  afterAll(async () => {
    await stack.down();
  });

  it('health y readiness del graphql-api', async () => {
    expect((await fetch(`${stack.url('graphql-api')}/health/live`)).status).toBe(200);
    expect((await fetch(`${stack.url('graphql-api')}/health/ready`)).status).toBe(200);
  });

  it('sin token o con un token forjado → UNAUTHENTICATED', async () => {
    const anonymous = await gql('{ featureFlags { environment } }', {}, { token: null });
    expect(anonymous.body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    const forged = `${tokens.alfa.slice(0, -4)}AAAA`;
    const tampered = await gql('{ featureFlags { environment } }', {}, { token: forged });
    expect(tampered.body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('consultas de catálogo, billetera y flags con un ID token real de Cognito', async () => {
    const result = await gql(`{
      stations(city: "medellin") { stationId connectors { connectorId status } }
      stationById(stationId: "${STATION}") { name }
      availableConnectors(stationId: "${STATION}") { connector { connectorId } }
      walletBalance { fleetId balance { amountMinor currency } }
      featureFlags { environment degraded flags { key enabled source } }
    }`);

    expect(result.body.errors).toBeUndefined();
    expect(result.body.data).toMatchObject({
      stations: [{ stationId: STATION }],
      stationById: { name: 'Estación GraphQL Norte' },
      walletBalance: { fleetId: ALFA, balance: { amountMinor: 20_000_000, currency: 'COP' } },
      featureFlags: { environment: 'local', degraded: false },
    });
    expect(
      (result.body.data as { availableConnectors: unknown[] }).availableConnectors,
    ).toHaveLength(3);
  });

  it('un operador no ve la billetera de otra flota; un administrador sí', async () => {
    const forbidden = await gql(`{ walletBalance(fleetId: "${BETA}") { fleetId } }`);
    expect(forbidden.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const admin = await gql(
      `{ walletBalance(fleetId: "${BETA}") { fleetId } }`,
      {},
      { token: tokens.admin },
    );
    expect(admin.body.data).toEqual({ walletBalance: { fleetId: BETA } });
  });

  let completed: { sagaId: string; sessionId: string; reservationId: string };

  it('reserveAndActivateCharging → SAGA COMPLETED, con el correlation_id propagado a todo', async () => {
    const correlationId = randomUUID();
    const key = randomUUID();
    const result = await gql<{
      reserveAndActivateCharging: { finished: boolean; saga: Record<string, string> };
    }>(
      reserve,
      {
        input: {
          idempotencyKey: key,
          stationId: STATION,
          connectorId: 'cn_01',
          requestedEnergyKwh: 30,
        },
      },
      { correlationId },
    );

    expect(result.correlationId).toBe(correlationId);
    expect(result.body.errors).toBeUndefined();
    const saga = result.body.data?.reserveAndActivateCharging.saga;
    expect(result.body.data?.reserveAndActivateCharging.finished).toBe(true);
    expect(saga).toMatchObject({ status: 'COMPLETED', correlationId, sagaId: `saga_${key}` });
    completed = {
      sagaId: saga?.sagaId ?? '',
      sessionId: saga?.sessionId ?? '',
      reservationId: saga?.reservationId ?? '',
    };

    // Repetir la mutación con la misma clave devuelve la misma SAGA (sin otro cobro).
    const again = await gql<{ reserveAndActivateCharging: { saga: Record<string, string> } }>(
      reserve,
      {
        input: {
          idempotencyKey: key,
          stationId: STATION,
          connectorId: 'cn_01',
          requestedEnergyKwh: 30,
        },
      },
    );
    expect(again.body.data?.reserveAndActivateCharging.saga.sagaId).toBe(completed.sagaId);

    const evidence = await collect(stack, completed.sagaId);
    save('graphql-01-reserva-completada', evidence);
    expect(evidence.ledger.map((e) => e.type)).toEqual(['DEBIT']);
    expect(evidence.ledger[0]?.correlationId).toBe(correlationId);
    for (const service of [
      'graphql-api',
      'saga-orchestrator',
      'station-reservation',
      'billing-wallet',
      'energy-dispatch',
    ]) {
      const log = readFileSync(join(EVIDENCE_DIR, 'logs', `${service}.log`), 'utf8');
      expect(log, service).toContain(correlationId);
    }
  });

  it('sagaStatus, reservations, transactions, chargingSessions y chargingSessionById', async () => {
    const result = await gql(`{
      sagaStatus(sagaId: "${completed.sagaId}") { status events { sequence type status } }
      reservations(first: 5) { items { reservationId status } pageInfo { hasNextPage } }
      transactions(first: 5) { items { type amount { amountMinor } sagaId } }
      chargingSessions(stationId: "${STATION}", active: true) { items { sessionId status } }
      chargingSessionById(sessionId: "${completed.sessionId}") { status requestedEnergyKwh telemetry { powerKw } }
    }`);

    expect(result.body.errors).toBeUndefined();
    expect(result.body.data).toMatchObject({
      sagaStatus: { status: 'COMPLETED' },
      reservations: { items: [{ reservationId: completed.reservationId, status: 'CONFIRMED' }] },
      // El más reciente primero: el cobro de la SAGA y la recarga inicial.
      transactions: {
        items: [
          { type: 'DEBIT', amount: { amountMinor: 3_000_000 }, sagaId: completed.sagaId },
          { type: 'TOP_UP', amount: { amountMinor: 20_000_000 }, sagaId: null },
        ],
      },
      chargingSessions: { items: [{ sessionId: completed.sessionId, status: 'ACTIVE' }] },
      chargingSessionById: { status: 'ACTIVE', requestedEnergyKwh: 30, telemetry: [] },
    });
    const events = (result.body.data as { sagaStatus: { events: { type: string }[] } }).sagaStatus
      .events;
    expect(events.at(-1)?.type).toBe('SAGA_COMPLETED');
  });

  it('releaseReservation con la carga activa → CONFLICT; stopChargingSession la detiene y libera el conector', async () => {
    const release = `mutation { releaseReservation(reservationId: "${completed.reservationId}") { outcome reservation { status } } }`;
    const blocked = await gql(release);
    expect(blocked.body.errors?.[0]?.extensions).toMatchObject({
      code: 'CONFLICT',
      reason: 'CHARGING_SESSION_ACTIVE',
    });

    const otherFleet = await gql(
      `mutation { stopChargingSession(sessionId: "${completed.sessionId}") { outcome } }`,
      {},
      { token: tokens.beta },
    );
    expect(otherFleet.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    const stopped = await gql(`mutation { stopChargingSession(sessionId: "${completed.sessionId}") {
      outcome reservationOutcome session { status stopReason } } }`);
    expect(stopped.body.data).toEqual({
      stopChargingSession: {
        outcome: 'STOPPED',
        reservationOutcome: 'RELEASED',
        session: { status: 'COMPLETED', stopReason: 'USER_REQUEST' },
      },
    });

    const after = await gql(
      `{ stationById(stationId: "${STATION}") { connectors { connectorId status } } }`,
    );
    expect(after.body.data).toMatchObject({
      stationById: {
        connectors: expect.arrayContaining([
          { connectorId: 'cn_01', status: 'AVAILABLE' },
        ]) as unknown,
      },
    });
    // Liberar de nuevo es idempotente.
    expect((await gql(release)).body.data).toEqual({
      releaseReservation: { outcome: 'ALREADY_RELEASED', reservation: { status: 'RELEASED' } },
    });
    save('graphql-02-carga-detenida', await collect(stack, completed.sagaId));
  });

  it('updateFeatureFlag: el operador no puede; el administrador activa la falla y la SAGA se compensa', async () => {
    const update = `mutation($input: UpdateFeatureFlagInput!) {
      updateFeatureFlag(input: $input) { changed flag { key enabled version } change { changedBy environment } }
    }`;
    const input = { key: 'SIMULATE_CHARGER_HARDWARE_FAULT', enabled: true };

    const operator = await gql(update, { input });
    expect(operator.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');

    const admin = await gql<{
      updateFeatureFlag: { changed: boolean; change: { environment: string } };
    }>(update, { input }, { token: tokens.admin });
    expect(admin.body.data?.updateFeatureFlag).toMatchObject({
      changed: true,
      change: { environment: 'local' },
    });

    try {
      const failed = await gql<{ reserveAndActivateCharging: { saga: Record<string, string> } }>(
        reserve,
        {
          input: {
            idempotencyKey: randomUUID(),
            stationId: STATION,
            connectorId: 'cn_02',
            requestedEnergyKwh: 30,
          },
        },
      );
      const saga = failed.body.data?.reserveAndActivateCharging.saga;
      expect(saga).toMatchObject({
        status: 'COMPENSATED',
        failureReason: 'CHARGER_HARDWARE_FAULT',
      });

      const evidence = await collect(stack, saga?.sagaId ?? '');
      save('graphql-03-falla-compensada', evidence);
      expect(evidence.debit?.status).toBe('REFUNDED');
      expect(evidence.reservation?.status).toBe('RELEASED');
      const wallet = await gql(`{ walletBalance { balance { amountMinor } } }`);
      // 20.000.000 − 3.000.000 (carga completada) = 17.000.000; el cobro fallido se reembolsó.
      expect(wallet.body.data).toEqual({ walletBalance: { balance: { amountMinor: 17_000_000 } } });
    } finally {
      await gql(update, { input: { ...input, enabled: false } }, { token: tokens.admin });
    }
  });

  it('validación de entrada en el borde: ids y energía inválidos → BAD_USER_INPUT sin llamar a servicios', async () => {
    const result = await gql(reserve, {
      input: {
        idempotencyKey: 'no-uuid',
        stationId: 'X',
        connectorId: 'cn_01',
        requestedEnergyKwh: -5,
      },
    });
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});
