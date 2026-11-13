import type {
  ChargingConnector,
  City,
  ConnectorId,
  Reservation,
  ReservationId,
  ReservationTombstone,
  Station,
  StationId,
} from '../../domain/index.ts';

/** Valor leído junto con su versión (concurrencia optimista). */
export interface Versioned<T> {
  readonly value: T;
  readonly version: number;
}

/** Nuevo estado a escribir, condicionado a que la versión almacenada no haya cambiado. */
export interface VersionedUpdate<T> {
  readonly value: T;
  readonly expectedVersion: number;
}

export interface StationEntry {
  readonly station: Station;
  readonly connectors: readonly ChargingConnector[];
}

export interface StationRepository {
  findById(stationId: StationId): Promise<StationEntry | undefined>;
  listByCity(city: City): Promise<StationEntry[]>;
  /**
   * Crea la estación y sus conectores en una sola transacción.
   * Lanza `StationAlreadyExistsError` si la estación ya existe.
   */
  create(entry: StationEntry): Promise<void>;
}

export type StoredReservation =
  | { readonly kind: 'RESERVATION'; readonly reservation: Versioned<Reservation> }
  | { readonly kind: 'TOMBSTONE'; readonly tombstone: ReservationTombstone };

/**
 * Persistencia de reservas y del estado de los conectores. Cada `save*` es
 * atómico (una transacción DynamoDB) y lanza `ConcurrentModificationError` si
 * alguna condición falla (versión cambiada, id ya usado…).
 */
export interface ReservationRepository {
  findConnector(
    stationId: StationId,
    connectorId: ConnectorId,
  ): Promise<Versioned<ChargingConnector> | undefined>;

  findReservation(reservationId: ReservationId): Promise<StoredReservation | undefined>;

  /**
   * Bloqueo del conector + alta de la reserva (+ marca EXPIRED de la reserva
   * vencida desplazada, si la hay).
   */
  saveHold(input: {
    connector: VersionedUpdate<ChargingConnector>;
    reservation: Reservation;
    displaced: VersionedUpdate<Reservation> | undefined;
    /** Instante con el que el dominio evaluó la disponibilidad (y el vencimiento). */
    now: Date;
  }): Promise<void>;

  /**
   * Cambia la reserva y, si corresponde, el conector (confirmación o liberación).
   * El conector solo se modifica si su bloqueo pertenece a esta reserva.
   */
  saveTransition(input: {
    reservation: VersionedUpdate<Reservation>;
    connector: VersionedUpdate<ChargingConnector> | undefined;
    now: Date;
  }): Promise<void>;

  /** Registra un tombstone; falla si ese id ya existe (reserva o tombstone). */
  saveTombstone(tombstone: ReservationTombstone): Promise<void>;
}
