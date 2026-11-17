import { createLogger } from '@aegisvolt/logger';
import { runWithLogContext } from '@aegisvolt/logger';
import type { ApolloServer } from '@apollo/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ADMIN_GROUP,
  FlagSnapshotCache,
  GetFeatureFlags,
  OPERATOR_GROUP,
  UpdateFeatureFlag,
  UpstreamUnavailableError,
  type Principal,
} from '../../src/application/index.ts';
import { createBffUseCases } from '../../src/composition.ts';
import type { GraphqlContext } from '../../src/presentation/graphql/resolvers.ts';
import { createGraphqlServer } from '../../src/presentation/graphql/server.ts';
import {
  FLEET,
  FakeUpstreams,
  KEY,
  OTHER_FLEET,
  RES,
  SAGA,
  SES,
  STATION,
  views,
} from '../support/fake-upstreams.ts';
import {
  FixedClock,
  InMemoryFeatureFlagRepository,
} from '../support/in-memory-feature-flag-repository.ts';

const OPERATOR: Principal = { subject: 'op-sub', groups: [OPERATOR_GROUP], fleetId: FLEET };
const ADMIN: Principal = { subject: 'admin-sub', groups: [ADMIN_GROUP] };
const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const silent = createLogger({
  service: 'test',
  environment: 'test',
  version: 'test',
  destination: { write: () => undefined },
});

let server: ApolloServer<GraphqlContext>;
let upstreams: FakeUpstreams;
let flagsRepo: InMemoryFeatureFlagRepository;

beforeAll(async () => {
  server = createGraphqlServer({ logger: silent, introspection: true, maxDepth: 8 });
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(() => {
  upstreams = new FakeUpstreams();
  const clock = new FixedClock(new Date('2026-11-13T15:00:00.000Z'));
  flagsRepo = InMemoryFeatureFlagRepository.seeded('dev', clock.now());
  const deps = {
    flags: flagsRepo,
    cache: new FlagSnapshotCache({ ttlMs: 0, clock }),
    clock,
    environment: 'dev' as const,
  };
  contextUseCases = {
    ...createBffUseCases(upstreams.build(), 'dev'),
    getFeatureFlags: new GetFeatureFlags(deps),
    updateFeatureFlag: new UpdateFeatureFlag(deps),
  };
});
let contextUseCases: GraphqlContext['useCases'];

interface Result {
  data?: Record<string, unknown> | null;
  errors?: readonly { message: string; extensions?: Record<string, unknown> }[];
}

async function run(
  query: string,
  variables: Record<string, unknown> = {},
  /** null = sin identidad (petición sin token o con un token inválido). */
  principal: Principal | null = OPERATOR,
): Promise<Result> {
  const response = await runWithLogContext({ correlationId: CORRELATION_ID }, () =>
    server.executeOperation(
      { query, variables },
      { contextValue: { principal: principal ?? undefined, useCases: contextUseCases } },
    ),
  );
  if (response.body.kind !== 'single') {
    throw new Error('respuesta incremental inesperada');
  }
  return response.body.singleResult;
}

const codeOf = (result: Result) => result.errors?.[0]?.extensions?.code;

describe('Queries', () => {
  it('stations, stationById y availableConnectors', async () => {
    const result = await run(`{
      stations(city: "bogota") { stationId name connectors { connectorId status availableForReservation } }
      stationById(stationId: "${STATION}") { stationId location { latitude } }
      missing: stationById(stationId: "st_no-existe") { stationId }
      availableConnectors(city: "bogota") { stationId connector { connectorId } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({
      stations: [
        { stationId: STATION, connectors: [{ connectorId: 'cn_01', status: 'AVAILABLE' }] },
      ],
      stationById: { stationId: STATION, location: { latitude: 4.7 } },
      missing: null,
      availableConnectors: [{ stationId: STATION }],
    });
  });

  it('walletBalance y transactions usan la flota del token del operador', async () => {
    const result = await run(`{
      walletBalance { fleetId balance { amountMinor currency } }
      transactions(first: 5) { items { type amount { amountMinor } sagaId } pageInfo { endCursor hasNextPage } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({
      walletBalance: { fleetId: FLEET, balance: { amountMinor: 4_700_000_000, currency: 'COP' } },
      transactions: {
        items: [{ type: 'DEBIT', sagaId: SAGA }],
        pageInfo: { endCursor: 'cur-2', hasNextPage: true },
      },
    });
    expect(upstreams.callsTo('listTransactions')[0]?.args).toEqual([
      FLEET,
      { limit: 5, cursor: undefined },
    ]);
  });

  it('reservations, chargingSessions, chargingSessionById con telemetría y sagaStatus con eventos', async () => {
    const result = await run(`{
      reservations { items { reservationId status } pageInfo { hasNextPage } }
      chargingSessions(stationId: "${STATION}", active: true) { items { sessionId status } }
      chargingSessionById(sessionId: "${SES}") { status telemetry(last: 3) { powerKw energyKwh } }
      sagaStatus(sagaId: "${SAGA}") { status terminal reservationId events { sequence type } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({
      reservations: {
        items: [{ reservationId: RES, status: 'CONFIRMED' }],
        pageInfo: { hasNextPage: false },
      },
      chargingSessions: { items: [{ sessionId: SES, status: 'ACTIVE' }] },
      chargingSessionById: { status: 'ACTIVE', telemetry: [{ powerKw: 58 }] },
      sagaStatus: {
        status: 'COMPLETED',
        terminal: true,
        reservationId: RES,
        events: [{ sequence: 0, type: 'SAGA_STARTED' }],
      },
    });
    expect(upstreams.callsTo('listTelemetry')[0]?.args).toEqual([SES, 3]);
  });

  it('featureFlags del ambiente del despliegue (sin argumento de ambiente)', async () => {
    const result = await run(
      `{ featureFlags { environment degraded flags { key enabled source } } }`,
    );

    expect(result.data).toMatchObject({
      featureFlags: {
        environment: 'dev',
        degraded: false,
        flags: expect.arrayContaining([
          { key: 'ENABLE_DYNAMIC_SURGE_PRICING', enabled: true, source: 'STORE' },
        ]) as unknown,
      },
    });
    const withEnv = await run(`{ featureFlags(environment: "prod") { environment } }`);
    expect(codeOf(withEnv)).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});

describe('Consultas de la consola', () => {
  it('viewer: flota, rol y ambiente del despliegue', async () => {
    const result = await run(`{ viewer { subject fleetId isAdmin groups environment } }`);
    expect(result.data).toEqual({
      viewer: {
        subject: 'op-sub',
        fleetId: FLEET,
        isAdmin: false,
        groups: ['fleet-operators'],
        environment: 'dev',
      },
    });
  });

  it('chargingEstimate usa la potencia del conector real y el cálculo de billing', async () => {
    const result =
      await run(`{ chargingEstimate(stationId: "${STATION}", connectorId: "cn_01", requestedEnergyKwh: 30) {
      fleetId connectorPowerKw estimated { amountMinor currency } sufficient surgeApplied surgeMultiplierBasisPoints } }`);

    expect(result.data).toEqual({
      chargingEstimate: {
        fleetId: FLEET,
        connectorPowerKw: 60,
        estimated: { amountMinor: 3_750_000, currency: 'COP' },
        sufficient: true,
        surgeApplied: true,
        surgeMultiplierBasisPoints: 12_500,
      },
    });
    expect(upstreams.callsTo('checkFunds')[0]?.args).toEqual([
      FLEET,
      { energyKwh: 30, connectorPowerKw: 60 },
    ]);
    const missing = await run(
      `{ chargingEstimate(stationId: "${STATION}", connectorId: "cn_99", requestedEnergyKwh: 30) { sufficient } }`,
    );
    expect(codeOf(missing)).toBe('NOT_FOUND');
  });

  it('sagas de la flota y systemStatus con la readiness de cada servicio', async () => {
    const result = await run(`{ sagas(first: 5) { sagaId status }
      systemStatus { environment services { service ready latencyMs } } }`);

    expect(result.data).toMatchObject({
      sagas: [{ sagaId: SAGA, status: 'COMPLETED' }],
      systemStatus: {
        environment: 'dev',
        services: [
          { service: 'station-reservation-service', ready: true },
          { service: 'billing-wallet-service', ready: false },
        ],
      },
    });
    expect(upstreams.callsTo('listSagas')[0]?.args).toEqual([
      FLEET,
      { status: undefined, limit: 5 },
    ]);
  });
});

describe('Autorización', () => {
  it('sin identidad → UNAUTHENTICATED', async () => {
    const result = await run(`{ stations(city: "bogota") { stationId } }`, {}, null);
    expect(codeOf(result)).toBe('UNAUTHENTICATED');
    expect(result.errors?.[0]?.extensions?.correlationId).toBe(CORRELATION_ID);
  });

  it('un operador no puede ver la billetera ni la SAGA de otra flota', async () => {
    expect(codeOf(await run(`{ walletBalance(fleetId: "${OTHER_FLEET}") { fleetId } }`))).toBe(
      'FORBIDDEN',
    );
    upstreams.sagas.set(SAGA, views.saga({ fleetId: OTHER_FLEET }));
    expect(codeOf(await run(`{ sagaStatus(sagaId: "${SAGA}") { status } }`))).toBe('FORBIDDEN');
  });

  it('un administrador debe indicar la flota', async () => {
    expect(codeOf(await run(`{ walletBalance { fleetId } }`, {}, ADMIN))).toBe('FORBIDDEN');
    const ok = await run(`{ walletBalance(fleetId: "${FLEET}") { fleetId } }`, {}, ADMIN);
    expect(ok.errors).toBeUndefined();
  });

  it('updateFeatureFlag solo para platform-admins (mutación administrativa)', async () => {
    const mutation = `mutation($input: UpdateFeatureFlagInput!) {
      updateFeatureFlag(input: $input) { changed flag { key enabled version } change { from to changedBy environment correlationId } }
    }`;
    const input = { key: 'SIMULATE_CHARGER_HARDWARE_FAULT', enabled: true };

    expect(codeOf(await run(mutation, { input }, OPERATOR))).toBe('FORBIDDEN');
    expect(flagsRepo.audit).toHaveLength(0);

    const ok = await run(mutation, { input }, ADMIN);
    expect(ok.data).toMatchObject({
      updateFeatureFlag: {
        changed: true,
        flag: { key: 'SIMULATE_CHARGER_HARDWARE_FAULT', enabled: true, version: 2 },
        change: {
          from: false,
          to: true,
          changedBy: 'admin-sub',
          environment: 'dev',
          correlationId: CORRELATION_ID,
        },
      },
    });
  });
});

describe('Validación y límites', () => {
  it('ids, rangos y paginación inválidos → BAD_USER_INPUT con detalle por campo', async () => {
    const badId = await run(`{ stationById(stationId: "x") { stationId } }`);
    expect(codeOf(badId)).toBe('BAD_USER_INPUT');
    expect(badId.errors?.[0]?.extensions?.fields).toEqual([
      expect.objectContaining({ path: 'stationId' }),
    ]);
    expect(codeOf(await run(`{ transactions(first: 500) { items { type } } }`))).toBe(
      'BAD_USER_INPUT',
    );
    expect(
      codeOf(
        await run(`{ availableConnectors(city: "bogota", stationId: "${STATION}") { stationId } }`),
      ),
    ).toBe('BAD_USER_INPUT');
    expect(upstreams.calls).toHaveLength(0);
  });

  it('energía fuera de rango o clave idempotente inválida en la mutación', async () => {
    const mutation = `mutation($input: ReserveAndActivateChargingInput!) {
      reserveAndActivateCharging(input: $input) { finished }
    }`;
    const input = {
      idempotencyKey: KEY,
      stationId: STATION,
      connectorId: 'cn_01',
      requestedEnergyKwh: 900,
    };
    expect(codeOf(await run(mutation, { input }))).toBe('BAD_USER_INPUT');
    expect(
      codeOf(
        await run(mutation, { input: { ...input, requestedEnergyKwh: 30, idempotencyKey: 'abc' } }),
      ),
    ).toBe('BAD_USER_INPUT');
    expect(upstreams.callsTo('startSaga')).toHaveLength(0);
  });

  it('consultas demasiado profundas se rechazan antes de ejecutar', async () => {
    const result = await run(`{ sagaStatus(sagaId: "${SAGA}") { compensationFailure { step }
      steps { step } events { sequence } } stations(city: "bogota") { connectors { connectorId } } }`);
    expect(result.errors).toBeUndefined();

    const deep = await run(`fragment F on Station { connectors { connectorId } }
      query { a: stations(city: "bogota") { ...F location { latitude } }
      b: stationById(stationId: "${STATION}") { connectors { connectorId } } }`);
    expect(deep.errors).toBeUndefined();

    const tooDeepServer = createGraphqlServer({
      logger: silent,
      introspection: false,
      maxDepth: 2,
    });
    await tooDeepServer.start();
    const response = await tooDeepServer.executeOperation(
      { query: `{ stations(city: "bogota") { connectors { connectorId } } }` },
      { contextValue: { principal: OPERATOR, useCases: contextUseCases } },
    );
    await tooDeepServer.stop();
    expect(
      response.body.kind === 'single' && response.body.singleResult.errors?.[0]?.extensions?.code,
    ).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});

describe('Mutaciones', () => {
  const reserve = `mutation($input: ReserveAndActivateChargingInput!) {
    reserveAndActivateCharging(input: $input) { finished saga { sagaId status } }
  }`;

  it('reserveAndActivateCharging invoca la SAGA con la flota del token y la clave idempotente', async () => {
    const result = await run(reserve, {
      input: {
        idempotencyKey: KEY,
        stationId: STATION,
        connectorId: 'cn_01',
        requestedEnergyKwh: 30,
      },
    });

    expect(result.data).toEqual({
      reserveAndActivateCharging: { finished: true, saga: { sagaId: SAGA, status: 'COMPLETED' } },
    });
    expect(upstreams.callsTo('startSaga')[0]?.args).toEqual([
      {
        fleetId: FLEET,
        stationId: STATION,
        connectorId: 'cn_01',
        requestedEnergyKwh: 30,
        fastChargeBoost: false,
      },
      KEY,
    ]);
  });

  it('reserveAndActivateCharging para otra flota → FORBIDDEN sin llamar al orquestador', async () => {
    const result = await run(reserve, {
      input: {
        idempotencyKey: KEY,
        fleetId: OTHER_FLEET,
        stationId: STATION,
        connectorId: 'cn_01',
        requestedEnergyKwh: 30,
      },
    });
    expect(codeOf(result)).toBe('FORBIDDEN');
    expect(upstreams.callsTo('startSaga')).toHaveLength(0);
  });

  it('stopChargingSession detiene la carga y libera la reserva', async () => {
    const result = await run(`mutation { stopChargingSession(sessionId: "${SES}") {
      outcome reservationOutcome session { status stopReason } } }`);

    expect(result.data).toEqual({
      stopChargingSession: {
        outcome: 'STOPPED',
        reservationOutcome: 'RELEASED',
        session: { status: 'COMPLETED', stopReason: 'USER_REQUEST' },
      },
    });
    expect(upstreams.callsTo('releaseReservation')[0]?.args).toEqual([
      RES,
      { sagaId: SAGA, reason: 'OPERATOR_REQUEST' },
    ]);
  });

  it('releaseReservation: CONFLICT con la carga activa o la SAGA en curso; libera si terminó', async () => {
    const release = `mutation { releaseReservation(reservationId: "${RES}") { outcome reservation { status } } }`;

    const active = await run(release);
    expect(active.errors?.[0]?.extensions).toMatchObject({
      code: 'CONFLICT',
      reason: 'CHARGING_SESSION_ACTIVE',
    });

    upstreams.sagas.set(SAGA, views.saga({ status: 'BILLING_COMPLETED', terminal: false }));
    const inProgress = await run(release);
    expect(inProgress.errors?.[0]?.extensions).toMatchObject({
      code: 'CONFLICT',
      reason: 'SAGA_IN_PROGRESS',
    });
    expect(upstreams.callsTo('releaseReservation')).toHaveLength(0);

    upstreams.sagas.set(SAGA, views.saga());
    upstreams.sessions.set(SES, views.session({ status: 'COMPLETED' }));
    const released = await run(release);
    expect(released.data).toEqual({
      releaseReservation: { outcome: 'RELEASED', reservation: { status: 'RELEASED' } },
    });
  });
});

describe('Errores centralizados', () => {
  it('servicio no disponible → SERVICE_UNAVAILABLE sin detalles internos', async () => {
    upstreams.failNext = {
      operation: 'listStations',
      error: new UpstreamUnavailableError(
        'station-reservation-service',
        'timeout en 10.0.0.12:4101',
      ),
    };
    const result = await run(`{ stations(city: "bogota") { stationId } }`);

    expect(result.errors?.[0]).toMatchObject({
      message: 'Servicio no disponible temporalmente; reintente',
      extensions: { code: 'SERVICE_UNAVAILABLE', correlationId: CORRELATION_ID },
    });
    expect(JSON.stringify(result)).not.toContain('10.0.0.12');
  });

  it('error inesperado → INTERNAL_SERVER_ERROR genérico, sin stacktrace ni mensaje interno', async () => {
    upstreams.failNext = {
      operation: 'getWallet',
      error: new Error('secret=abc123 en /srv/app/billing.ts:42'),
    };
    const result = await run(`{ walletBalance { fleetId } }`);

    expect(result.errors?.[0]).toMatchObject({
      message: 'Error interno',
      extensions: { code: 'INTERNAL_SERVER_ERROR', correlationId: CORRELATION_ID },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('stacktrace');
  });
});
