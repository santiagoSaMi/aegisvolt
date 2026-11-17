import {
  billingWalletV1 as billingApi,
  energyDispatchV1 as dispatchApi,
  stationReservationV1 as stationApi,
} from '@aegisvolt/contracts';

import type {
  BillingWalletPort,
  CallContext,
  CallOutcome,
  CompensationReason,
  EnergyDispatchPort,
  SagaParticipants,
  StationReservationPort,
} from '../../application/index.ts';
import type {
  ConnectorId,
  DebitId,
  ReservationId,
  SessionId,
  StationId,
} from '../../domain/index.ts';
import { ServiceHttpClient } from './service-http-client.ts';

/** Adaptador HTTP de station-reservation-service (contrato stationReservationV1). */
export class HttpStationReservation implements StationReservationPort {
  private readonly http: ServiceHttpClient;

  constructor(http: ServiceHttpClient) {
    this.http = http;
  }

  async getConnectorPower(
    target: { stationId: StationId; connectorId: ConnectorId },
    ctx: CallContext,
  ): Promise<CallOutcome<{ maxPowerKw: number }>> {
    const station = await this.http.call({
      method: 'GET',
      path: stationApi.paths.station(target.stationId),
      ctx,
      schema: stationApi.stationViewSchema,
    });
    if (station.kind !== 'OK') {
      return station;
    }
    const connector = station.value.connectors.find(
      (c) => String(c.connectorId) === String(target.connectorId),
    );
    return connector === undefined
      ? { kind: 'REJECTED', code: 'CONNECTOR_NOT_FOUND' }
      : { kind: 'OK', value: { maxPowerKw: connector.maxPowerKw } };
  }

  holdReservation(
    command: Parameters<StationReservationPort['holdReservation']>[0],
    ctx: CallContext,
  ) {
    const { reservationId, ...body } = command;
    return this.http.call({
      method: 'PUT',
      path: stationApi.paths.reservation(reservationId),
      body,
      ctx,
      schema: stationApi.reservationViewSchema,
    });
  }

  confirmReservation(reservationId: ReservationId, ctx: CallContext) {
    return this.http.call({
      method: 'POST',
      path: stationApi.paths.confirmReservation(reservationId),
      body: {},
      ctx,
      schema: stationApi.reservationViewSchema,
    });
  }

  releaseReservation(reservationId: ReservationId, reason: CompensationReason, ctx: CallContext) {
    return this.http.call({
      method: 'POST',
      path: stationApi.paths.releaseReservation(reservationId),
      body: { reason },
      ctx,
      schema: stationApi.releaseReservationResponseSchema,
    });
  }
}

/** Adaptador HTTP de billing-wallet-service (contrato billingWalletV1). */
export class HttpBillingWallet implements BillingWalletPort {
  private readonly http: ServiceHttpClient;

  constructor(http: ServiceHttpClient) {
    this.http = http;
  }

  async debit(command: Parameters<BillingWalletPort['debit']>[0], ctx: CallContext) {
    const { debitId, ...body } = command;
    const result = await this.http.call({
      method: 'PUT',
      path: billingApi.paths.debit(debitId),
      body,
      ctx,
      schema: billingApi.debitViewSchema,
    });
    return result.kind === 'OK'
      ? {
          kind: 'OK' as const,
          value: { status: result.value.status, amountMinor: result.value.amount.amountMinor },
        }
      : result;
  }

  refundDebit(debitId: DebitId, reason: CompensationReason, ctx: CallContext) {
    return this.http.call({
      method: 'POST',
      path: billingApi.paths.refundDebit(debitId),
      body: { reason },
      ctx,
      schema: billingApi.refundDebitResponseSchema,
    });
  }
}

/** Adaptador HTTP de energy-dispatch-service (contrato energyDispatchV1). */
export class HttpEnergyDispatch implements EnergyDispatchPort {
  private readonly http: ServiceHttpClient;

  constructor(http: ServiceHttpClient) {
    this.http = http;
  }

  activateSession(command: Parameters<EnergyDispatchPort['activateSession']>[0], ctx: CallContext) {
    const { sessionId, ...body } = command;
    return this.http.call({
      method: 'PUT',
      path: dispatchApi.paths.session(sessionId),
      body,
      ctx,
      schema: dispatchApi.sessionViewSchema,
    });
  }

  getSession(sessionId: SessionId, ctx: CallContext) {
    return this.http.call({
      method: 'GET',
      path: dispatchApi.paths.session(sessionId),
      ctx,
      schema: dispatchApi.sessionViewSchema,
    });
  }

  abortSession(sessionId: SessionId, reason: CompensationReason, ctx: CallContext) {
    return this.http.call({
      method: 'POST',
      path: dispatchApi.paths.abortSession(sessionId),
      body: { reason },
      ctx,
      schema: dispatchApi.abortSessionResponseSchema,
    });
  }
}

export function createHttpParticipants(config: {
  stationReservationUrl: string;
  billingWalletUrl: string;
  energyDispatchUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): SagaParticipants {
  const client = (baseUrl: string) =>
    new ServiceHttpClient({
      baseUrl,
      timeoutMs: config.timeoutMs,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
  return {
    station: new HttpStationReservation(client(config.stationReservationUrl)),
    billing: new HttpBillingWallet(client(config.billingWalletUrl)),
    dispatch: new HttpEnergyDispatch(client(config.energyDispatchUrl)),
  };
}
