import {
  HTTP_HEADERS,
  billingWalletV1 as billing,
  energyDispatchV1 as dispatch,
  sagaOrchestratorV1 as orchestrator,
  stationReservationV1 as station,
} from '@aegisvolt/contracts';

import {
  UpstreamRejectedError,
  type BillingWalletGateway,
  type EnergyDispatchGateway,
  type PageRequest,
  type SagaOrchestratorGateway,
  type StationReservationGateway,
  type Upstreams,
} from '../../application/index.ts';
import { ServiceClient } from './service-client.ts';

/** Un 404 del servicio en una lectura por id significa "no existe". */
async function orUndefined<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof UpstreamRejectedError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

const pageQuery = (page: PageRequest) => ({ limit: page.limit, cursor: page.cursor });

export class HttpStationReservationGateway implements StationReservationGateway {
  private readonly http: ServiceClient;

  constructor(http: ServiceClient) {
    this.http = http;
  }

  async listStations(city: string) {
    const result = await this.http.call({
      method: 'GET',
      path: station.paths.stations(),
      query: { city },
      schema: station.listStationsResponseSchema,
      idempotent: true,
    });
    return result.items;
  }

  getStation(stationId: string) {
    return orUndefined(() =>
      this.http.call({
        method: 'GET',
        path: station.paths.station(stationId),
        schema: station.stationViewSchema,
        idempotent: true,
      }),
    );
  }

  async listAvailableConnectors(filter: { city: string } | { stationId: string }) {
    const result = await this.http.call({
      method: 'GET',
      path: station.paths.availableConnectors(),
      query: filter,
      schema: station.listAvailableConnectorsResponseSchema,
      idempotent: true,
    });
    return result.items;
  }

  listReservations(fleetId: string, page: PageRequest) {
    return this.http.call({
      method: 'GET',
      path: station.paths.reservations(),
      query: { fleetId, ...pageQuery(page) },
      schema: station.listReservationsResponseSchema,
      idempotent: true,
    });
  }

  getReservation(reservationId: string) {
    return orUndefined(() =>
      this.http.call({
        method: 'GET',
        path: station.paths.reservation(reservationId),
        schema: station.reservationViewSchema,
        idempotent: true,
      }),
    );
  }

  releaseReservation(
    reservationId: string,
    command: { sagaId: string; reason: 'OPERATOR_REQUEST' },
  ) {
    return this.http.call({
      method: 'POST',
      path: station.paths.releaseReservation(reservationId),
      headers: { [HTTP_HEADERS.sagaId]: command.sagaId },
      body: { reason: command.reason },
      schema: station.releaseReservationResponseSchema,
      // Idempotente: repetirla responde ALREADY_RELEASED.
      idempotent: true,
    });
  }
}

export class HttpBillingWalletGateway implements BillingWalletGateway {
  private readonly http: ServiceClient;

  constructor(http: ServiceClient) {
    this.http = http;
  }

  getWallet(fleetId: string) {
    return orUndefined(() =>
      this.http.call({
        method: 'GET',
        path: billing.paths.wallet(fleetId),
        schema: billing.walletViewSchema,
        idempotent: true,
      }),
    );
  }

  listTransactions(fleetId: string, page: PageRequest) {
    return this.http.call({
      method: 'GET',
      path: billing.paths.walletTransactions(fleetId),
      query: pageQuery(page),
      schema: billing.listWalletTransactionsResponseSchema,
      idempotent: true,
    });
  }
}

export class HttpEnergyDispatchGateway implements EnergyDispatchGateway {
  private readonly http: ServiceClient;

  constructor(http: ServiceClient) {
    this.http = http;
  }

  listStationSessions(stationId: string, query: PageRequest & { active: boolean }) {
    return this.http.call({
      method: 'GET',
      path: dispatch.paths.stationSessions(stationId),
      query: { active: query.active, ...pageQuery(query) },
      schema: dispatch.listSessionsResponseSchema,
      idempotent: true,
    });
  }

  getSession(sessionId: string) {
    return orUndefined(() =>
      this.http.call({
        method: 'GET',
        path: dispatch.paths.session(sessionId),
        schema: dispatch.sessionViewSchema,
        idempotent: true,
      }),
    );
  }

  async listTelemetry(sessionId: string, limit: number) {
    const result = await this.http.call({
      method: 'GET',
      path: dispatch.paths.sessionTelemetry(sessionId),
      query: { limit },
      schema: dispatch.listTelemetryResponseSchema,
      idempotent: true,
    });
    return result.items;
  }

  stopSession(sessionId: string, reason: 'USER_REQUEST' | 'OPERATOR_REQUEST') {
    return this.http.call({
      method: 'POST',
      path: dispatch.paths.stopSession(sessionId),
      body: { reason },
      schema: dispatch.stopSessionResponseSchema,
      // Idempotente: repetirla responde ALREADY_STOPPED.
      idempotent: true,
    });
  }
}

export class HttpSagaOrchestratorGateway implements SagaOrchestratorGateway {
  private readonly http: ServiceClient;
  private readonly startTimeoutMs: number;

  constructor(http: ServiceClient, options: { startTimeoutMs: number }) {
    this.http = http;
    this.startTimeoutMs = options.startTimeoutMs;
  }

  async startSaga(
    request: Parameters<SagaOrchestratorGateway['startSaga']>[0],
    idempotencyKey: string,
  ) {
    const saga = await this.http.call({
      method: 'POST',
      path: orchestrator.paths.sagas(),
      headers: { [HTTP_HEADERS.idempotencyKey]: idempotencyKey },
      body: request,
      schema: orchestrator.sagaViewSchema,
      // La misma idempotency-key nunca crea otra SAGA: repetir es seguro.
      idempotent: true,
      // El orquestador espera hasta su SAGA_SYNC_WAIT_MS antes de responder 202.
      timeoutMs: this.startTimeoutMs,
    });
    return { saga, finished: saga.terminal };
  }

  getSaga(sagaId: string) {
    return orUndefined(() =>
      this.http.call({
        method: 'GET',
        path: orchestrator.paths.saga(sagaId),
        schema: orchestrator.sagaViewSchema,
        idempotent: true,
      }),
    );
  }

  async listSagaEvents(sagaId: string) {
    const result = await this.http.call({
      method: 'GET',
      path: orchestrator.paths.sagaEvents(sagaId),
      schema: orchestrator.listSagaEventsResponseSchema,
      idempotent: true,
    });
    return result.items;
  }
}

export interface UpstreamsConfig {
  readonly stationReservationUrl: string;
  readonly billingWalletUrl: string;
  readonly energyDispatchUrl: string;
  readonly sagaOrchestratorUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly sagaStartTimeoutMs: number;
  readonly fetch?: typeof fetch;
}

export function createUpstreams(config: UpstreamsConfig): Upstreams {
  const client = (service: string, baseUrl: string) =>
    new ServiceClient({
      service,
      baseUrl,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
  return {
    station: new HttpStationReservationGateway(
      client('station-reservation-service', config.stationReservationUrl),
    ),
    billing: new HttpBillingWalletGateway(
      client('billing-wallet-service', config.billingWalletUrl),
    ),
    dispatch: new HttpEnergyDispatchGateway(
      client('energy-dispatch-service', config.energyDispatchUrl),
    ),
    orchestrator: new HttpSagaOrchestratorGateway(
      client('saga-orchestrator-service', config.sagaOrchestratorUrl),
      { startTimeoutMs: config.sagaStartTimeoutMs },
    ),
  };
}
