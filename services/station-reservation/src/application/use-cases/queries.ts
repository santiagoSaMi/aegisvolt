import {
  City,
  FleetId,
  ReservationId,
  StationId,
  type ChargingConnector,
  type Reservation,
  type Station,
} from '../../domain/index.ts';
import { ReservationNotFoundError, StationNotFoundError } from '../errors.ts';
import type {
  ReservationRepository,
  StationEntry,
  StationRepository,
} from '../ports/repositories.ts';
import type { Clock } from '../ports/services.ts';

/**
 * Consultas. Devuelven también `now`: la presentación calcula el estado
 * efectivo (holds vencidos) con el mismo instante que se usó para filtrar.
 */

export class GetReservation {
  private readonly reservations: ReservationRepository;
  private readonly clock: Clock;

  constructor(deps: { reservations: ReservationRepository; clock: Clock }) {
    this.reservations = deps.reservations;
    this.clock = deps.clock;
  }

  async execute(reservationId: string): Promise<{ reservation: Reservation; now: Date }> {
    const id = ReservationId.parse(reservationId);
    const stored = await this.reservations.findReservation(id);
    if (stored?.kind !== 'RESERVATION') {
      throw new ReservationNotFoundError(`No existe la reserva ${id}`);
    }
    return { reservation: stored.reservation.value, now: this.clock.now() };
  }
}

/** Reservas de una flota (estado efectivo con `now`), la más reciente primero. */
export class ListFleetReservations {
  private readonly reservations: ReservationRepository;
  private readonly clock: Clock;

  constructor(deps: { reservations: ReservationRepository; clock: Clock }) {
    this.reservations = deps.reservations;
    this.clock = deps.clock;
  }

  async execute(query: {
    fleetId: string;
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: readonly Reservation[]; nextCursor?: string; now: Date }> {
    const page = await this.reservations.listReservationsByFleet(FleetId.parse(query.fleetId), {
      limit: query.limit,
      cursor: query.cursor,
    });
    return { ...page, now: this.clock.now() };
  }
}

export class GetStation {
  private readonly stations: StationRepository;
  private readonly clock: Clock;

  constructor(deps: { stations: StationRepository; clock: Clock }) {
    this.stations = deps.stations;
    this.clock = deps.clock;
  }

  async execute(stationId: string): Promise<{ entry: StationEntry; now: Date }> {
    const id = StationId.parse(stationId);
    const entry = await this.stations.findById(id);
    if (entry === undefined) {
      throw new StationNotFoundError(`No existe la estación ${id}`);
    }
    return { entry, now: this.clock.now() };
  }
}

export class ListStations {
  private readonly stations: StationRepository;
  private readonly clock: Clock;

  constructor(deps: { stations: StationRepository; clock: Clock }) {
    this.stations = deps.stations;
    this.clock = deps.clock;
  }

  async execute(city: string): Promise<{ entries: StationEntry[]; now: Date }> {
    const entries = await this.stations.listByCity(City.of(city));
    return { entries, now: this.clock.now() };
  }
}

export interface AvailableConnector {
  readonly station: Station;
  readonly connector: ChargingConnector;
}

export type AvailableConnectorsQuery = { readonly city: string } | { readonly stationId: string };

/** Conectores que se pueden reservar ahora (incluye los de holds vencidos). */
export class GetAvailableConnectors {
  private readonly stations: StationRepository;
  private readonly clock: Clock;

  constructor(deps: { stations: StationRepository; clock: Clock }) {
    this.stations = deps.stations;
    this.clock = deps.clock;
  }

  async execute(
    query: AvailableConnectorsQuery,
  ): Promise<{ items: AvailableConnector[]; now: Date }> {
    let entries: StationEntry[];
    if ('city' in query) {
      entries = await this.stations.listByCity(City.of(query.city));
    } else {
      const entry = await this.stations.findById(StationId.parse(query.stationId));
      if (entry === undefined) {
        throw new StationNotFoundError(`No existe la estación ${query.stationId}`);
      }
      entries = [entry];
    }
    const now = this.clock.now();
    const items = entries.flatMap(({ station, connectors }) =>
      connectors
        .filter((connector) => connector.isAvailableAt(now))
        .map((connector) => ({ station, connector })),
    );
    return { items, now };
  }
}
