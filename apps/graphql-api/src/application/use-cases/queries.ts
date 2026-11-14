import { flagsPolicy, fleetPolicy, type Principal } from '../authorization.ts';
import { NotFoundError } from '../errors.ts';
import type { DeploymentEnvironment } from '../ports/feature-flags.ts';
import type {
  AvailableConnectorView,
  FundsCheckView,
  ServiceHealth,
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

/** Identidad de quien llama, para que la interfaz muestre su flota y su rol. */
export interface Viewer {
  readonly subject: string;
  readonly groups: readonly string[];
  readonly fleetId: string | undefined;
  readonly isAdmin: boolean;
  /** Ambiente del despliegue que responde (APP_ENV), no elegible por el cliente. */
  readonly environment: DeploymentEnvironment;
}

export class GetViewer {
  private readonly environment: DeploymentEnvironment;

  constructor(deps: { environment: DeploymentEnvironment }) {
    this.environment = deps.environment;
  }

  execute(principal: Principal | undefined): Viewer {
    const caller = flagsPolicy.assertCanRead(principal);
    return {
      subject: caller.subject,
      groups: caller.groups,
      fleetId: caller.fleetId,
      isAdmin: fleetPolicy.isAdmin(caller),
      environment: this.environment,
    };
  }
}

export interface ChargingEstimate {
  readonly fleetId: string;
  readonly connectorPowerKw: number;
  readonly requestedEnergyKwh: number;
  readonly check: FundsCheckView;
}

/**
 * Estimación previa a iniciar una carga: la potencia sale del conector real
 * (station-reservation) y el importe de la política de precios de billing
 * (tarifa, surge y flags). El BFF no calcula precios.
 */
export class EstimateCharging {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  async execute(
    principal: Principal | undefined,
    input: {
      fleetId?: string | undefined;
      stationId: string;
      connectorId: string;
      requestedEnergyKwh: number;
    },
  ): Promise<ChargingEstimate> {
    const fleetId = fleetPolicy.resolveFleet(principal, input.fleetId);
    const station = await this.upstreams.station.getStation(input.stationId);
    const connector = station?.connectors.find((c) => String(c.connectorId) === input.connectorId);
    if (connector === undefined) {
      throw new NotFoundError(`No existe el conector ${input.connectorId} en ${input.stationId}`);
    }
    const check = await this.upstreams.billing.checkFunds(fleetId, {
      energyKwh: input.requestedEnergyKwh,
      connectorPowerKw: connector.maxPowerKw,
    });
    return {
      fleetId,
      connectorPowerKw: connector.maxPowerKw,
      requestedEnergyKwh: input.requestedEnergyKwh,
      check,
    };
  }
}

/** SAGAs de la flota (historial de operaciones, errores y compensaciones). */
export class ListFleetSagas {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  execute(
    principal: Principal | undefined,
    query: { fleetId?: string | undefined; status?: string | undefined; limit: number },
  ): Promise<readonly SagaView[]> {
    const fleetId = fleetPolicy.resolveFleet(principal, query.fleetId);
    return this.upstreams.orchestrator.listSagas(fleetId, {
      status: query.status,
      limit: query.limit,
    });
  }
}

/** Estado del sistema: readiness de cada servicio interno (sin datos de negocio). */
export class GetSystemStatus {
  private readonly upstreams: Upstreams;

  constructor(deps: { upstreams: Upstreams }) {
    this.upstreams = deps.upstreams;
  }

  async execute(principal: Principal | undefined): Promise<readonly ServiceHealth[]> {
    flagsPolicy.assertCanRead(principal);
    return this.upstreams.health.check();
  }
}
