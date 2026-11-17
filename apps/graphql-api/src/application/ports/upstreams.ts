import type {
  billingWalletV1,
  energyDispatchV1,
  sagaOrchestratorV1,
  stationReservationV1,
} from '@aegisvolt/contracts';

/**
 * Puertos hacia los servicios. El BFF NO tiene persistencia de negocio: todo
 * dato de estaciones, reservas, billeteras, sesiones y SAGAs se obtiene de su
 * servicio dueño a través de su API (nunca de su tabla). Los tipos son las
 * vistas de los contratos públicos (`@aegisvolt/contracts`).
 *
 * Errores: un rechazo del servicio → `UpstreamRejectedError` (con su status y
 * `code`); servicio no disponible tras los reintentos permitidos →
 * `UpstreamUnavailableError`.
 */
export type StationView = stationReservationV1.StationView;
export type AvailableConnectorView = stationReservationV1.AvailableConnectorView;
export type ReservationView = stationReservationV1.ReservationView;
export type WalletView = billingWalletV1.WalletView;
export type WalletTransactionView = billingWalletV1.WalletTransactionView;
export type SessionView = energyDispatchV1.SessionView;
export type TelemetryRecordView = energyDispatchV1.TelemetryRecordView;
export type SagaView = sagaOrchestratorV1.SagaView;
export type SagaEventView = sagaOrchestratorV1.SagaEventView;
export type FundsCheckView = billingWalletV1.FundsCheckView;

/** Readiness de un servicio (para el estado del sistema). */
export interface ServiceHealth {
  readonly service: string;
  readonly ready: boolean;
  readonly latencyMs: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface StationReservationGateway {
  listStations(city: string): Promise<readonly StationView[]>;
  /** `undefined` si no existe. */
  getStation(stationId: string): Promise<StationView | undefined>;
  listAvailableConnectors(
    filter: { city: string } | { stationId: string },
  ): Promise<readonly AvailableConnectorView[]>;
  listReservations(fleetId: string, page: PageRequest): Promise<Page<ReservationView>>;
  getReservation(reservationId: string): Promise<ReservationView | undefined>;
  /** Liberación idempotente (`x-saga-id` = SAGA dueña de la reserva). */
  releaseReservation(
    reservationId: string,
    command: { sagaId: string; reason: 'OPERATOR_REQUEST' },
  ): Promise<{ status: string; outcome: string }>;
}

export interface BillingWalletGateway {
  getWallet(fleetId: string): Promise<WalletView | undefined>;
  listTransactions(fleetId: string, page: PageRequest): Promise<Page<WalletTransactionView>>;
  /** Importe estimado de una carga (lo calcula billing con su política de precios y flags). */
  checkFunds(
    fleetId: string,
    query: { energyKwh: number; connectorPowerKw: number },
  ): Promise<FundsCheckView>;
}

export interface EnergyDispatchGateway {
  listStationSessions(
    stationId: string,
    query: PageRequest & { active: boolean },
  ): Promise<Page<SessionView>>;
  getSession(sessionId: string): Promise<SessionView | undefined>;
  listTelemetry(sessionId: string, limit: number): Promise<readonly TelemetryRecordView[]>;
  /** Parada idempotente (STOPPED · ALREADY_STOPPED). */
  stopSession(
    sessionId: string,
    reason: 'USER_REQUEST' | 'OPERATOR_REQUEST',
  ): Promise<{ status: string; outcome: string }>;
}

export interface SagaOrchestratorGateway {
  /**
   * Inicia (o repite, con la misma clave) la SAGA. `finished` = la SAGA llegó a un
   * estado terminal dentro de la espera síncrona del orquestador (201); si no (202),
   * se consulta luego con `sagaStatus`.
   */
  startSaga(
    request: {
      fleetId: string;
      stationId: string;
      connectorId: string;
      requestedEnergyKwh: number;
      fastChargeBoost: boolean;
    },
    idempotencyKey: string,
  ): Promise<{ saga: SagaView; finished: boolean }>;
  getSaga(sagaId: string): Promise<SagaView | undefined>;
  listSagas(
    fleetId: string,
    query: { status?: string | undefined; limit: number },
  ): Promise<readonly SagaView[]>;
  listSagaEvents(sagaId: string): Promise<readonly SagaEventView[]>;
}

/** Readiness de los servicios internos (sin datos de negocio). */
export interface HealthGateway {
  check(): Promise<readonly ServiceHealth[]>;
}

export interface Upstreams {
  readonly station: StationReservationGateway;
  readonly billing: BillingWalletGateway;
  readonly dispatch: EnergyDispatchGateway;
  readonly orchestrator: SagaOrchestratorGateway;
  readonly health: HealthGateway;
}
