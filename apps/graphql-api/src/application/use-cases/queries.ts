import { flagsPolicy, fleetPolicy, type Principal } from '../authorization.ts';
import { NotFoundError } from '../errors.ts';
import type {
  AvailableConnectorView,
  Page,
  PageRequest,
  ReservationView,
  SagaEventView,
  SagaView,
  SessionView,
  StationView,
  TelemetryRecordView,
  Upstreams,
  WalletTransactionView,
  WalletView,
} from '../ports/upstreams.ts';

/**
 * Consultas del BFF: autorizan y delegan en el servicio dueño de cada dato. No
 * hay reglas de negocio ni acceso a tablas de otros servicios.
 *
 * Visibilidad (ADR-0026):
 * - catálogo de estaciones, conectores disponibles y sesiones de carga por
 *   estación: cualquier usuario autenticado (datos operativos, sin importes);
 * - billetera, movimientos, reservas y SAGAs: solo la flota dueña o un administrador.
 */
export class CatalogQueries {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  stations(principal: Principal | undefined, city: string): Promise<readonly StationView[]> {
    flagsPolicy.assertCanRead(principal);
    return this.upstreams.station.listStations(city);
  }

  stationById(
    principal: Principal | undefined,
    stationId: string,
  ): Promise<StationView | undefined> {
    flagsPolicy.assertCanRead(principal);
    return this.upstreams.station.getStation(stationId);
  }

  availableConnectors(
    principal: Principal | undefined,
    filter: { city: string } | { stationId: string },
  ): Promise<readonly AvailableConnectorView[]> {
    flagsPolicy.assertCanRead(principal);
    return this.upstreams.station.listAvailableConnectors(filter);
  }

  chargingSessions(
    principal: Principal | undefined,
    stationId: string,
    query: PageRequest & { active: boolean },
  ): Promise<Page<SessionView>> {
    flagsPolicy.assertCanRead(principal);
    return this.upstreams.dispatch.listStationSessions(stationId, query);
  }

  chargingSessionById(
    principal: Principal | undefined,
    sessionId: string,
  ): Promise<SessionView | undefined> {
    flagsPolicy.assertCanRead(principal);
    return this.upstreams.dispatch.getSession(sessionId);
  }

  sessionTelemetry(
    principal: Principal | undefined,
    sessionId: string,
    limit: number,
  ): Promise<readonly TelemetryRecordView[]> {
    flagsPolicy.assertCanRead(principal);
    return this.upstreams.dispatch.listTelemetry(sessionId, limit);
  }
}

export class FleetQueries {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  async walletBalance(
    principal: Principal | undefined,
    requestedFleet: string | undefined,
  ): Promise<WalletView> {
    const fleetId = fleetPolicy.resolveFleet(principal, requestedFleet);
    const wallet = await this.upstreams.billing.getWallet(fleetId);
    if (wallet === undefined) {
      throw new NotFoundError(`La flota ${fleetId} no tiene billetera`);
    }
    return wallet;
  }

  transactions(
    principal: Principal | undefined,
    requestedFleet: string | undefined,
    page: PageRequest,
  ): Promise<Page<WalletTransactionView>> {
    const fleetId = fleetPolicy.resolveFleet(principal, requestedFleet);
    return this.upstreams.billing.listTransactions(fleetId, page);
  }

  reservations(
    principal: Principal | undefined,
    requestedFleet: string | undefined,
    page: PageRequest,
  ): Promise<Page<ReservationView>> {
    const fleetId = fleetPolicy.resolveFleet(principal, requestedFleet);
    return this.upstreams.station.listReservations(fleetId, page);
  }

  /** SAGA de la flota de quien llama (otra flota → no visible: `undefined`). */
  async sagaStatus(
    principal: Principal | undefined,
    sagaId: string,
  ): Promise<SagaView | undefined> {
    flagsPolicy.assertCanRead(principal);
    const saga = await this.upstreams.orchestrator.getSaga(sagaId);
    if (saga === undefined) {
      return undefined;
    }
    fleetPolicy.assertCanAccess(principal, saga.fleetId);
    return saga;
  }

  async sagaEvents(
    principal: Principal | undefined,
    saga: SagaView,
  ): Promise<readonly SagaEventView[]> {
    fleetPolicy.assertCanAccess(principal, saga.fleetId);
    return this.upstreams.orchestrator.listSagaEvents(saga.sagaId);
  }
}
