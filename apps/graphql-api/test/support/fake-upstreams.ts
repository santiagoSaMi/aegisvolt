import {
  UpstreamRejectedError,
  type Page,
  type ReservationView,
  type SagaEventView,
  type SagaView,
  type SessionView,
  type StationView,
  type Upstreams,
  type WalletTransactionView,
  type WalletView,
} from '../../src/application/index.ts';

export const NOW = '2026-11-13T15:00:00.000Z';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const FLEET = 'fleet_alfa';
export const OTHER_FLEET = 'fleet_beta';
export const STATION = 'st_bog-norte-01';
export const KEY = uuid(1);
export const SAGA = `saga_${KEY}`;
export const RES = `res_${KEY}`;
export const SES = `ses_${KEY}`;
export const DBT = `dbt_${KEY}`;

/** Fábricas de vistas válidas según los contratos (tipadas con `as`, son datos de prueba). */
export const views = {
  station: (): StationView =>
    ({
      stationId: STATION,
      name: 'Norte 01',
      city: 'bogota',
      location: { latitude: 4.7, longitude: -74.05 },
      connectors: [
        {
          connectorId: 'cn_01',
          type: 'CCS2',
          maxPowerKw: 60,
          ultraFast: false,
          status: 'AVAILABLE',
          availableForReservation: true,
        },
      ],
    }) as StationView,
  reservation: (overrides: Partial<Record<string, unknown>> = {}): ReservationView =>
    ({
      reservationId: RES,
      sagaId: SAGA,
      fleetId: FLEET,
      stationId: STATION,
      connectorId: 'cn_01',
      status: 'CONFIRMED',
      fastChargeBoost: false,
      holdExpiresAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }) as ReservationView,
  saga: (overrides: Partial<Record<string, unknown>> = {}): SagaView =>
    ({
      sagaId: SAGA,
      status: 'COMPLETED',
      terminal: true,
      fleetId: FLEET,
      stationId: STATION,
      connectorId: 'cn_01',
      requestedEnergyKwh: 30,
      fastChargeBoost: false,
      correlationId: uuid(99),
      reservationId: RES,
      debitId: DBT,
      sessionId: SES,
      compensationPlan: [],
      steps: [
        {
          step: 'RESERVATION',
          status: 'SUCCEEDED',
          attempts: 1,
          idempotencyKey: RES,
          updatedAt: NOW,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }) as unknown as SagaView,
  session: (overrides: Partial<Record<string, unknown>> = {}): SessionView =>
    ({
      sessionId: SES,
      sagaId: SAGA,
      stationId: STATION,
      connectorId: 'cn_01',
      status: 'ACTIVE',
      requestedEnergyKwh: 30,
      startedAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }) as SessionView,
  wallet: (): WalletView =>
    ({
      fleetId: FLEET,
      balance: { amountMinor: 4_700_000_000, currency: 'COP' },
      updatedAt: NOW,
    }) as WalletView,
  transaction: (): WalletTransactionView =>
    ({
      transactionId: `wtx_debit-${KEY}`,
      fleetId: FLEET,
      type: 'DEBIT',
      amount: { amountMinor: 3_000_000, currency: 'COP' },
      balanceAfter: { amountMinor: 4_700_000_000, currency: 'COP' },
      operationId: DBT,
      sagaId: SAGA,
      debitId: DBT,
      correlationId: uuid(99),
      idempotencyKey: DBT,
      occurredAt: NOW,
    }) as WalletTransactionView,
};

export interface RecordedCall {
  readonly operation: string;
  readonly args: readonly unknown[];
}

const notFound = (service: string) =>
  new UpstreamRejectedError({ service, status: 404, upstreamCode: 'NOT_FOUND' });

/**
 * Servicios falsos, coherentes entre sí: una flota con una SAGA completada, su
 * reserva confirmada y su sesión activa. Registran cada llamada.
 */
export class FakeUpstreams {
  readonly calls: RecordedCall[] = [];
  readonly stations = new Map<string, StationView>([[STATION, views.station()]]);
  readonly reservations = new Map<string, ReservationView>([[RES, views.reservation()]]);
  readonly sagas = new Map<string, SagaView>([[SAGA, views.saga()]]);
  readonly sessions = new Map<string, SessionView>([[SES, views.session()]]);
  readonly wallets = new Map<string, WalletView>([[FLEET, views.wallet()]]);
  readonly events: SagaEventView[] = [
    {
      sequence: 0,
      type: 'SAGA_STARTED',
      status: 'STARTED',
      occurredAt: NOW,
      correlationId: uuid(99),
    },
  ];
  /** Fallo a inyectar en la próxima llamada a `operation`. */
  failNext: { operation: string; error: Error } | undefined;
  /** Resultado de iniciar la SAGA. */
  startResult: { saga: SagaView; finished: boolean } = { saga: views.saga(), finished: true };

  private record(operation: string, ...args: unknown[]): void {
    this.calls.push({ operation, args });
    if (this.failNext?.operation === operation) {
      const { error } = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }

  callsTo(operation: string): RecordedCall[] {
    return this.calls.filter((c) => c.operation === operation);
  }

  build(): Upstreams {
    const page = <T>(items: readonly T[]): Page<T> => ({ items });
    return {
      station: {
        listStations: (city) => {
          this.record('listStations', city);
          return Promise.resolve([...this.stations.values()].filter((s) => s.city === city));
        },
        getStation: (id) => {
          this.record('getStation', id);
          return Promise.resolve(this.stations.get(id));
        },
        listAvailableConnectors: (filter) => {
          this.record('listAvailableConnectors', filter);
          return Promise.resolve([
            {
              stationId: STATION,
              stationName: 'Norte 01',
              city: 'bogota',
              connector: views.station().connectors[0],
            },
          ] as never);
        },
        listReservations: (fleetId, request) => {
          this.record('listReservations', fleetId, request);
          return Promise.resolve(
            page([...this.reservations.values()].filter((r) => r.fleetId === fleetId)),
          );
        },
        getReservation: (id) => {
          this.record('getReservation', id);
          return Promise.resolve(this.reservations.get(id));
        },
        releaseReservation: (id, command) => {
          this.record('releaseReservation', id, command);
          const current = this.reservations.get(id);
          if (current === undefined) {
            return Promise.reject(notFound('station'));
          }
          const already = current.status === 'RELEASED';
          this.reservations.set(id, { ...current, status: 'RELEASED' });
          return Promise.resolve({
            status: 'RELEASED',
            outcome: already ? 'ALREADY_RELEASED' : 'RELEASED',
          });
        },
      },
      billing: {
        getWallet: (fleetId) => {
          this.record('getWallet', fleetId);
          return Promise.resolve(this.wallets.get(fleetId));
        },
        checkFunds: (fleetId, query) => {
          this.record('checkFunds', fleetId, query);
          return Promise.resolve({
            fleetId,
            sufficient: true,
            required: { amountMinor: 3_750_000, currency: 'COP' },
            available: { amountMinor: 4_700_000_000, currency: 'COP' },
            pricing: {
              tariffMinorPerKwh: 100_000,
              surgeMultiplierBasisPoints: 12_500,
              surgeApplied: true,
            },
          } as never);
        },
        listTransactions: (fleetId, request) => {
          this.record('listTransactions', fleetId, request);
          return Promise.resolve({
            items: fleetId === FLEET ? [views.transaction()] : [],
            nextCursor: 'cur-2',
          });
        },
      },
      dispatch: {
        listStationSessions: (stationId, query) => {
          this.record('listStationSessions', stationId, query);
          return Promise.resolve(
            page([...this.sessions.values()].filter((s) => !query.active || s.status === 'ACTIVE')),
          );
        },
        getSession: (id) => {
          this.record('getSession', id);
          return Promise.resolve(this.sessions.get(id));
        },
        listTelemetry: (sessionId, limit) => {
          this.record('listTelemetry', sessionId, limit);
          return Promise.resolve([
            {
              sessionId,
              timestamp: NOW,
              voltageV: 400,
              currentA: 145,
              powerKw: 58,
              energyKwh: 1.2,
            },
          ] as never);
        },
        stopSession: (id, reason) => {
          this.record('stopSession', id, reason);
          const current = this.sessions.get(id);
          if (current === undefined) {
            return Promise.reject(notFound('dispatch'));
          }
          const already = current.status === 'COMPLETED';
          this.sessions.set(id, {
            ...current,
            status: 'COMPLETED',
            stopReason: reason,
          });
          return Promise.resolve({
            status: 'COMPLETED',
            outcome: already ? 'ALREADY_STOPPED' : 'STOPPED',
          });
        },
      },
      orchestrator: {
        startSaga: (request, key) => {
          this.record('startSaga', request, key);
          return Promise.resolve(this.startResult);
        },
        getSaga: (id) => {
          this.record('getSaga', id);
          return Promise.resolve(this.sagas.get(id));
        },
        listSagas: (fleetId, query) => {
          this.record('listSagas', fleetId, query);
          return Promise.resolve([...this.sagas.values()].filter((s) => s.fleetId === fleetId));
        },
        listSagaEvents: (id) => {
          this.record('listSagaEvents', id);
          return Promise.resolve(this.events);
        },
      },
      health: {
        check: () => {
          this.record('healthCheck');
          return Promise.resolve([
            { service: 'station-reservation-service', ready: true, latencyMs: 3 },
            { service: 'billing-wallet-service', ready: false, latencyMs: 1500 },
          ]);
        },
      },
    };
  }
}
