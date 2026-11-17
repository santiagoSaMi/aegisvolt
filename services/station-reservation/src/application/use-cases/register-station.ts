import {
  ChargingConnector,
  City,
  ConnectorId,
  GeoLocation,
  InvalidValueError,
  PowerKw,
  Station,
  StationId,
  type ConnectorType,
} from '../../domain/index.ts';
import { StationAlreadyExistsError } from '../errors.ts';
import type { StationEntry, StationRepository } from '../ports/repositories.ts';

export interface RegisterStationCommand {
  readonly stationId: string;
  readonly name: string;
  readonly city: string;
  readonly location: { readonly latitude: number; readonly longitude: number };
  readonly connectors: readonly {
    readonly connectorId: string;
    readonly type: ConnectorType;
    readonly maxPowerKw: number;
  }[];
}

export interface RegisterStationResult {
  /** CREATED: alta nueva · UNCHANGED: ya existía con los mismos datos (idempotente). */
  readonly outcome: 'CREATED' | 'UNCHANGED';
  readonly entry: StationEntry;
}

/** Alta de una estación con sus conectores (catálogo). Idempotente por `stationId`. */
export class RegisterStation {
  static readonly MAX_CONNECTORS = 20;

  private readonly stations: StationRepository;

  constructor(deps: { stations: StationRepository }) {
    this.stations = deps.stations;
  }

  async execute(command: RegisterStationCommand): Promise<RegisterStationResult> {
    const entry = buildEntry(command);
    const existing = await this.stations.findById(entry.station.id);
    if (existing !== undefined) {
      return compareWithExisting(existing, entry);
    }
    try {
      await this.stations.create(entry);
      return { outcome: 'CREATED', entry };
    } catch (error) {
      // Carrera con otra alta del mismo id: decide con los datos ya guardados.
      const raced =
        error instanceof StationAlreadyExistsError
          ? await this.stations.findById(entry.station.id)
          : undefined;
      if (raced === undefined) {
        throw error;
      }
      return compareWithExisting(raced, entry);
    }
  }
}

function buildEntry(command: RegisterStationCommand): StationEntry {
  if (
    command.connectors.length === 0 ||
    command.connectors.length > RegisterStation.MAX_CONNECTORS
  ) {
    throw new InvalidValueError(
      'connectors',
      `debe haber entre 1 y ${RegisterStation.MAX_CONNECTORS}`,
    );
  }
  const stationId = StationId.parse(command.stationId);
  const connectors = command.connectors.map((connector) =>
    ChargingConnector.create({
      id: ConnectorId.parse(connector.connectorId),
      stationId,
      type: connector.type,
      maxPower: PowerKw.of(connector.maxPowerKw),
    }),
  );
  if (new Set(connectors.map((connector) => connector.id)).size !== connectors.length) {
    throw new InvalidValueError('connectors', 'connectorId repetido');
  }
  const station = Station.create({
    id: stationId,
    name: command.name,
    city: City.of(command.city),
    location: GeoLocation.of(command.location.latitude, command.location.longitude),
  });
  return { station, connectors };
}

function compareWithExisting(
  existing: StationEntry,
  requested: StationEntry,
): RegisterStationResult {
  if (!sameCatalog(existing, requested)) {
    throw new StationAlreadyExistsError(
      `La estación ${requested.station.id} ya existe con otros datos`,
    );
  }
  return { outcome: 'UNCHANGED', entry: existing };
}

/** Compara solo datos de catálogo (no el estado operativo de los conectores). */
function sameCatalog(a: StationEntry, b: StationEntry): boolean {
  const key = (entry: StationEntry): string =>
    JSON.stringify({
      name: entry.station.name,
      city: entry.station.city.value,
      location: [entry.station.location.latitude, entry.station.location.longitude],
      connectors: [...entry.connectors]
        .map((c) => [c.id, c.type, c.maxPower.value])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    });
  return key(a) === key(b);
}
