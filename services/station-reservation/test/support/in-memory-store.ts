import {
  ConcurrentModificationError,
  StationAlreadyExistsError,
  type ReservationRepository,
  type StationEntry,
  type StationRepository,
  type StoredReservation,
  type Versioned,
  type VersionedUpdate,
} from '../../src/application/index.ts';
import type {
  ChargingConnector,
  City,
  ConnectorId,
  Reservation,
  ReservationId,
  ReservationTombstone,
  Station,
  StationId,
} from '../../src/domain/index.ts';

/**
 * Doble de prueba de la tabla DynamoDB: mismas reglas condicionales que los
 * repositorios reales (versión, `attribute_not_exists`, conector disponible en
 * `now`, bloqueo de la propia reserva). Las operaciones son async y ceden el
 * control, así que dos casos de uso concurrentes se intercalan de verdad.
 */
export class InMemoryStore {
  readonly stations = new Map<string, Station>();
  readonly connectors = new Map<string, Versioned<ChargingConnector>>();
  readonly records = new Map<string, StoredReservation>();
  writes = 0;
  /** Fuerza conflictos en las próximas N escrituras (para probar el reintento). */
  failNextWrites = 0;

  readonly stationRepository: StationRepository = {
    findById: async (stationId) => {
      await tick();
      return this.entryOf(stationId);
    },
    listByCity: async (city: City) => {
      await tick();
      return [...this.stations.values()]
        .filter((station) => station.city.equals(city))
        .map((station) => this.entryOf(station.id))
        .filter((entry): entry is StationEntry => entry !== undefined);
    },
    create: async (entry) => {
      await tick();
      if (this.stations.has(entry.station.id)) {
        throw new StationAlreadyExistsError(`La estación ${entry.station.id} ya existe`);
      }
      this.stations.set(entry.station.id, entry.station);
      for (const connector of entry.connectors) {
        this.connectors.set(connectorKey(connector.stationId, connector.id), {
          value: connector,
          version: 1,
        });
      }
    },
  };

  readonly reservationRepository: ReservationRepository = {
    findConnector: async (stationId: StationId, connectorId: ConnectorId) => {
      await tick();
      return this.connectors.get(connectorKey(stationId, connectorId));
    },
    findReservation: async (reservationId: ReservationId) => {
      await tick();
      return this.records.get(reservationId);
    },
    saveHold: async ({ connector, reservation, displaced, now }) => {
      await tick();
      this.beginWrite();
      const stored = this.connectors.get(
        connectorKey(connector.value.stationId, connector.value.id),
      );
      const available =
        stored !== undefined &&
        (stored.value.status === 'AVAILABLE' ||
          (stored.value.status === 'RESERVED' &&
            stored.value.hold !== undefined &&
            stored.value.hold.expiresAt.getTime() <= now.getTime()));
      if (stored?.version !== connector.expectedVersion || !available) {
        throw new ConcurrentModificationError('connector');
      }
      if (this.records.has(reservation.id)) {
        throw new ConcurrentModificationError('reservation exists');
      }
      if (displaced !== undefined) {
        this.assertReservationVersion(displaced);
      }
      this.applyConnector(connector);
      this.records.set(reservation.id, {
        kind: 'RESERVATION',
        reservation: { value: reservation, version: 1 },
      });
      if (displaced !== undefined) {
        this.applyReservation(displaced);
      }
    },
    saveTransition: async ({ reservation, connector }) => {
      await tick();
      this.beginWrite();
      this.assertReservationVersion(reservation);
      if (connector !== undefined) {
        const stored = this.connectors.get(
          connectorKey(connector.value.stationId, connector.value.id),
        );
        if (
          stored?.version !== connector.expectedVersion ||
          stored.value.hold?.reservationId !== reservation.value.id
        ) {
          throw new ConcurrentModificationError('connector');
        }
        this.applyConnector(connector);
      }
      this.applyReservation(reservation);
    },
    saveTombstone: async (tombstone: ReservationTombstone) => {
      await tick();
      this.beginWrite();
      if (this.records.has(tombstone.id)) {
        throw new ConcurrentModificationError('id exists');
      }
      this.records.set(tombstone.id, { kind: 'TOMBSTONE', tombstone });
    },
  };

  connector(stationId: string, connectorId: string): Versioned<ChargingConnector> | undefined {
    return this.connectors.get(`${stationId}|${connectorId}`);
  }

  reservation(reservationId: string): Versioned<Reservation> | undefined {
    const record = this.records.get(reservationId);
    return record?.kind === 'RESERVATION' ? record.reservation : undefined;
  }

  private beginWrite(): void {
    this.writes++;
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw new ConcurrentModificationError('forced');
    }
  }

  private entryOf(stationId: string): StationEntry | undefined {
    const station = this.stations.get(stationId);
    if (station === undefined) {
      return undefined;
    }
    const connectors = [...this.connectors.values()]
      .map((versioned) => versioned.value)
      .filter((connector) => connector.stationId === stationId);
    return { station, connectors };
  }

  private assertReservationVersion(update: VersionedUpdate<Reservation>): void {
    const record = this.records.get(update.value.id);
    if (record?.kind !== 'RESERVATION' || record.reservation.version !== update.expectedVersion) {
      throw new ConcurrentModificationError('reservation');
    }
  }

  private applyReservation(update: VersionedUpdate<Reservation>): void {
    this.records.set(update.value.id, {
      kind: 'RESERVATION',
      reservation: { value: update.value, version: update.expectedVersion + 1 },
    });
  }

  private applyConnector(update: VersionedUpdate<ChargingConnector>): void {
    this.connectors.set(connectorKey(update.value.stationId, update.value.id), {
      value: update.value,
      version: update.expectedVersion + 1,
    });
  }
}

function connectorKey(stationId: string, connectorId: string): string {
  return `${stationId}|${connectorId}`;
}

/** Cede el control al event loop (simula la latencia de red). */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class FixedClock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
