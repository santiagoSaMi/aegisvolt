import { gql, type TypedDocumentNode } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import { usePolling } from '../../shared/hooks/usePolling.ts';
import type { ActiveSession, Station } from './model.ts';

const STATION_FIELDS = gql`
  fragment StationFields on Station {
    stationId
    name
    city
    connectors {
      connectorId
      type
      maxPowerKw
      ultraFast
      status
      availableForReservation
    }
  }
`;

export const STATIONS_QUERY: TypedDocumentNode<{ stations: Station[] }, { city: string }> = gql`
  ${STATION_FIELDS}
  query Stations($city: String!) {
    stations(city: $city) {
      ...StationFields
    }
  }
`;

export const STATION_DETAIL_QUERY: TypedDocumentNode<
  { stationById: Station | null; chargingSessions: { items: ActiveSession[] } },
  { stationId: string }
> = gql`
  ${STATION_FIELDS}
  query StationDetail($stationId: ID!) {
    stationById(stationId: $stationId) {
      ...StationFields
    }
    chargingSessions(stationId: $stationId, active: true, first: 50) {
      items {
        sessionId
        connectorId
        status
        requestedEnergyKwh
        energyDeliveredKwh
        startedAt
        telemetry(last: 1) {
          timestamp
          powerKw
          energyKwh
        }
      }
    }
  }
`;

/** Estaciones de una ciudad con disponibilidad, refrescadas por polling. */
export function useStations(city: string) {
  const polling = usePolling();
  const result = useQuery(STATIONS_QUERY, { variables: { city }, ...polling });
  return {
    stations: result.data?.stations,
    loading: result.loading,
    error: result.error,
    refetch: result.refetch,
  };
}

/** Detalle de una estación con sus sesiones activas y última telemetría (polling). */
export function useStationDetail(stationId: string) {
  const polling = usePolling();
  const result = useQuery(STATION_DETAIL_QUERY, { variables: { stationId }, ...polling });
  return {
    station: result.data?.stationById,
    sessions: result.data?.chargingSessions.items ?? [],
    loading: result.loading,
    error: result.error,
    refetch: result.refetch,
  };
}
