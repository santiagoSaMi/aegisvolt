import {
  ChargingConnector,
  City,
  ConnectorId,
  FleetId,
  GeoLocation,
  PowerKw,
  Reservation,
  ReservationId,
  ReservationTombstone,
  SagaId,
  Station,
  StationId,
  type ConnectorStatus,
  type ConnectorType,
  type ReleaseReason,
  type ReservationStatus,
} from '../../domain/index.ts';
import { ENTITY, TERMINAL_RECORD_RETENTION_DAYS, keys } from './table.ts';

/** Forma de los ítems en DynamoDB (atributos planos, fechas ISO-8601 UTC). */

export interface StationItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.station;
  stationId: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
  GSI1PK: string;
  GSI1SK: string;
}

export interface ConnectorItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.connector;
  stationId: string;
  connectorId: string;
  type: ConnectorType;
  maxPowerKw: number;
  status: ConnectorStatus;
  holdReservationId?: string;
  holdExpiresAt?: string;
  version: number;
  updatedAt: string;
  GSI1PK: string;
  GSI1SK: string;
}

export interface ReservationItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.reservation;
  reservationId: string;
  sagaId: string;
  fleetId: string;
  stationId: string;
  connectorId: string;
  fastChargeBoost: boolean;
  status: ReservationStatus;
  holdExpiresAt: string;
  releaseReason?: ReleaseReason;
  createdAt: string;
  updatedAt: string;
  version: number;
  expiresAtEpoch?: number;
}

export interface TombstoneItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.tombstone;
  reservationId: string;
  reason: ReleaseReason;
  voidedAt: string;
  expiresAtEpoch: number;
}

/** Época (s) para el TTL de limpieza de registros terminales. */
export function retentionEpoch(from: Date): number {
  return Math.floor(from.getTime() / 1000) + TERMINAL_RECORD_RETENTION_DAYS * 86_400;
}

export function toStationItem(station: Station): StationItem {
  return {
    ...keys.station(station.id),
    entity: ENTITY.station,
    stationId: station.id,
    name: station.name,
    city: station.city.value,
    latitude: station.location.latitude,
    longitude: station.location.longitude,
    GSI1PK: keys.cityPartition(station.city.value),
    GSI1SK: `STATION#${station.id}`,
  };
}

export function toConnectorItem(
  connector: ChargingConnector,
  city: string,
  version: number,
  now: Date,
): ConnectorItem {
  return {
    ...keys.connector(connector.stationId, connector.id),
    entity: ENTITY.connector,
    stationId: connector.stationId,
    connectorId: connector.id,
    type: connector.type,
    maxPowerKw: connector.maxPower.value,
    status: connector.status,
    ...(connector.hold === undefined
      ? {}
      : {
          holdReservationId: connector.hold.reservationId,
          holdExpiresAt: connector.hold.expiresAt.toISOString(),
        }),
    version,
    updatedAt: now.toISOString(),
    GSI1PK: keys.cityPartition(city),
    GSI1SK: `STATION#${connector.stationId}#CONN#${connector.id}`,
  };
}

export function toReservationItem(reservation: Reservation, version: number): ReservationItem {
  const terminal = reservation.status === 'RELEASED' || reservation.status === 'EXPIRED';
  return {
    ...keys.reservation(reservation.id),
    entity: ENTITY.reservation,
    reservationId: reservation.id,
    sagaId: reservation.terms.sagaId,
    fleetId: reservation.terms.fleetId,
    stationId: reservation.terms.stationId,
    connectorId: reservation.terms.connectorId,
    fastChargeBoost: reservation.terms.fastChargeBoost,
    status: reservation.status,
    holdExpiresAt: reservation.holdExpiresAt.toISOString(),
    ...(reservation.releaseReason === undefined
      ? {}
      : { releaseReason: reservation.releaseReason }),
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
    version,
    ...(terminal ? { expiresAtEpoch: retentionEpoch(reservation.updatedAt) } : {}),
  };
}

export function toTombstoneItem(tombstone: ReservationTombstone): TombstoneItem {
  return {
    ...keys.reservation(tombstone.id),
    entity: ENTITY.tombstone,
    reservationId: tombstone.id,
    reason: tombstone.reason,
    voidedAt: tombstone.voidedAt.toISOString(),
    expiresAtEpoch: retentionEpoch(tombstone.voidedAt),
  };
}

export function fromStationItem(item: StationItem): Station {
  return Station.create({
    id: StationId.parse(item.stationId),
    name: item.name,
    city: City.of(item.city),
    location: GeoLocation.of(item.latitude, item.longitude),
  });
}

export function fromConnectorItem(item: ConnectorItem): ChargingConnector {
  const hold =
    item.holdReservationId !== undefined && item.holdExpiresAt !== undefined
      ? {
          reservationId: ReservationId.parse(item.holdReservationId),
          expiresAt: new Date(item.holdExpiresAt),
        }
      : undefined;
  return ChargingConnector.restore({
    id: ConnectorId.parse(item.connectorId),
    stationId: StationId.parse(item.stationId),
    type: item.type,
    maxPower: PowerKw.of(item.maxPowerKw),
    status: item.status,
    ...(hold === undefined ? {} : { hold }),
  });
}

export function fromReservationItem(item: ReservationItem): Reservation {
  return Reservation.restore({
    id: ReservationId.parse(item.reservationId),
    terms: {
      sagaId: SagaId.parse(item.sagaId),
      fleetId: FleetId.parse(item.fleetId),
      stationId: StationId.parse(item.stationId),
      connectorId: ConnectorId.parse(item.connectorId),
      fastChargeBoost: item.fastChargeBoost,
    },
    status: item.status,
    holdExpiresAt: new Date(item.holdExpiresAt),
    ...(item.releaseReason === undefined ? {} : { releaseReason: item.releaseReason }),
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
  });
}

export function fromTombstoneItem(item: TombstoneItem): ReservationTombstone {
  return ReservationTombstone.create(
    ReservationId.parse(item.reservationId),
    item.reason,
    new Date(item.voidedAt),
  );
}
