import type { stationReservationV1 } from '@aegisvolt/contracts';
import type { z } from 'zod';

import type { AvailableConnector, StationEntry } from '../../application/index.ts';
import type { ChargingConnector, Reservation } from '../../domain/index.ts';

/**
 * Domain → vistas públicas del contrato. Los estados se informan **efectivos**
 * en `now` (un hold vencido se ve AVAILABLE / EXPIRED aunque aún no se haya
 * persistido el cambio).
 *
 * Se tipan con `z.input` del esquema: lo que el servidor envía es la entrada
 * que el consumidor valida (ids como strings, sin las marcas de tipo de Zod).
 */
type ConnectorView = z.input<typeof stationReservationV1.connectorViewSchema>;
type StationView = z.input<typeof stationReservationV1.stationViewSchema>;
type ReservationView = z.input<typeof stationReservationV1.reservationViewSchema>;
type AvailableConnectorView = z.input<typeof stationReservationV1.availableConnectorViewSchema>;

export function toConnectorView(connector: ChargingConnector, now: Date): ConnectorView {
  return {
    connectorId: connector.id,
    type: connector.type,
    maxPowerKw: connector.maxPower.value,
    ultraFast: connector.ultraFast,
    status: connector.effectiveStatusAt(now),
    availableForReservation: connector.isAvailableAt(now),
  };
}

export function toStationView(entry: StationEntry, now: Date): StationView {
  const { station } = entry;
  return {
    stationId: station.id,
    name: station.name,
    city: station.city.value,
    location: { latitude: station.location.latitude, longitude: station.location.longitude },
    connectors: entry.connectors.map((connector) => toConnectorView(connector, now)),
  };
}

export function toAvailableConnectorView(
  item: AvailableConnector,
  now: Date,
): AvailableConnectorView {
  return {
    stationId: item.station.id,
    stationName: item.station.name,
    city: item.station.city.value,
    connector: toConnectorView(item.connector, now),
  };
}

export function toReservationView(reservation: Reservation, now: Date): ReservationView {
  return {
    reservationId: reservation.id,
    sagaId: reservation.terms.sagaId,
    fleetId: reservation.terms.fleetId,
    stationId: reservation.terms.stationId,
    connectorId: reservation.terms.connectorId,
    status: reservation.effectiveStatusAt(now),
    fastChargeBoost: reservation.terms.fastChargeBoost,
    holdExpiresAt: reservation.holdExpiresAt.toISOString(),
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
  };
}
