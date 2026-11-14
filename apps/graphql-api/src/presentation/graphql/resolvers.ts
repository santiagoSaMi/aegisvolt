import { getLogContext } from '@aegisvolt/logger';
import { randomUUID } from 'node:crypto';

import type {
  CatalogQueries,
  FeatureFlagsSnapshot,
  FleetQueries,
  GetFeatureFlags,
  Page,
  Principal,
  ReleaseReservation,
  ReserveAndActivateCharging,
  SagaView,
  SessionView,
  StopChargingSession,
  UpdateFeatureFlag,
} from '../../application/index.ts';
import { DateTimeScalar, SafeIntScalar } from './scalars.ts';
import { argsSchemas, parseArgs } from './validation.ts';

/** Casos de uso que necesita la capa GraphQL (inyectados desde la composición). */
export interface GraphqlUseCases {
  readonly catalog: CatalogQueries;
  readonly fleet: FleetQueries;
  readonly reserveAndActivateCharging: ReserveAndActivateCharging;
  readonly releaseReservation: ReleaseReservation;
  readonly stopChargingSession: StopChargingSession;
  readonly getFeatureFlags: GetFeatureFlags;
  readonly updateFeatureFlag: UpdateFeatureFlag;
}

/** Contexto por petición: identidad verificada (o ninguna) y casos de uso. */
export interface GraphqlContext {
  readonly principal: Principal | undefined;
  readonly useCases: GraphqlUseCases;
}

const connection = <T>(page: Page<T>) => ({
  items: page.items,
  pageInfo: { endCursor: page.nextCursor ?? null, hasNextPage: page.nextCursor !== undefined },
});

const flagsView = (snapshot: FeatureFlagsSnapshot) => ({
  environment: snapshot.environment,
  degraded: snapshot.degraded,
  readAt: snapshot.readAt,
  flags: snapshot.flags,
});

const correlationId = (): string => getLogContext()?.correlationId ?? randomUUID();

/**
 * Resolvers DELGADOS: validan los argumentos (`parseArgs`), delegan en un caso de
 * uso con la identidad del contexto y adaptan la forma de la respuesta. No acceden
 * a DynamoDB ni a servicios, y no contienen reglas de negocio ni pasos de la SAGA.
 */
export const resolvers = {
  DateTime: DateTimeScalar,
  SafeInt: SafeIntScalar,

  Query: {
    stations: (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { city } = parseArgs(argsSchemas.stations, args);
      return ctx.useCases.catalog.stations(ctx.principal, city);
    },
    stationById: async (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { stationId } = parseArgs(argsSchemas.stationById, args);
      return (await ctx.useCases.catalog.stationById(ctx.principal, stationId)) ?? null;
    },
    availableConnectors: (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { city, stationId } = parseArgs(argsSchemas.availableConnectors, args);
      return ctx.useCases.catalog.availableConnectors(
        ctx.principal,
        city === undefined ? { stationId: stationId ?? '' } : { city },
      );
    },
    walletBalance: (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { fleetId } = parseArgs(argsSchemas.fleetScoped, args);
      return ctx.useCases.fleet.walletBalance(ctx.principal, fleetId);
    },
    transactions: async (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { fleetId, first, after } = parseArgs(argsSchemas.fleetPage, args);
      return connection(
        await ctx.useCases.fleet.transactions(ctx.principal, fleetId, {
          limit: first,
          cursor: after,
        }),
      );
    },
    reservations: async (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { fleetId, first, after } = parseArgs(argsSchemas.fleetPage, args);
      return connection(
        await ctx.useCases.fleet.reservations(ctx.principal, fleetId, {
          limit: first,
          cursor: after,
        }),
      );
    },
    chargingSessions: async (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { stationId, active, first, after } = parseArgs(argsSchemas.chargingSessions, args);
      return connection(
        await ctx.useCases.catalog.chargingSessions(ctx.principal, stationId, {
          active,
          limit: first,
          cursor: after,
        }),
      );
    },
    chargingSessionById: async (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { sessionId } = parseArgs(argsSchemas.sessionById, args);
      return (await ctx.useCases.catalog.chargingSessionById(ctx.principal, sessionId)) ?? null;
    },
    sagaStatus: async (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { sagaId } = parseArgs(argsSchemas.sagaStatus, args);
      return (await ctx.useCases.fleet.sagaStatus(ctx.principal, sagaId)) ?? null;
    },
    featureFlags: async (_: unknown, __: unknown, ctx: GraphqlContext) =>
      flagsView(await ctx.useCases.getFeatureFlags.execute(ctx.principal)),
  },

  Mutation: {
    reserveAndActivateCharging: (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { input } = parseArgs(argsSchemas.reserveAndActivateCharging, args);
      return ctx.useCases.reserveAndActivateCharging.execute(ctx.principal, input);
    },
    releaseReservation: (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { reservationId } = parseArgs(argsSchemas.releaseReservation, args);
      return ctx.useCases.releaseReservation.execute(ctx.principal, reservationId);
    },
    stopChargingSession: (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { sessionId } = parseArgs(argsSchemas.sessionById, args);
      return ctx.useCases.stopChargingSession.execute(ctx.principal, sessionId);
    },
    updateFeatureFlag: async (_: unknown, args: unknown, ctx: GraphqlContext) => {
      const { input } = parseArgs(argsSchemas.updateFeatureFlag, args);
      const result = await ctx.useCases.updateFeatureFlag.execute(ctx.principal, {
        ...input,
        correlationId: correlationId(),
      });
      return {
        flag: {
          key: result.flag.key,
          enabled: result.flag.enabled,
          description: result.flag.description,
          version: result.flag.version,
          updatedAt: result.flag.updatedAt,
          updatedBy: result.flag.updatedBy,
          source: 'STORE',
        },
        changed: result.changed,
        change: result.change ?? null,
      };
    },
  },

  ChargingSession: {
    fault: (session: SessionView) => session.fault ?? null,
    telemetry: (session: SessionView, args: unknown, ctx: GraphqlContext) => {
      const { last } = parseArgs(argsSchemas.telemetry, args);
      return ctx.useCases.catalog.sessionTelemetry(ctx.principal, session.sessionId, last);
    },
  },

  Saga: {
    events: (saga: SagaView, _: unknown, ctx: GraphqlContext) =>
      ctx.useCases.fleet.sagaEvents(ctx.principal, saga),
  },
};
