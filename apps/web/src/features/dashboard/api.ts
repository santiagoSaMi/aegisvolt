import { gql, type TypedDocumentNode } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import { usePolling } from '../../shared/hooks/usePolling.ts';
import type { Station } from '../stations/model.ts';

export interface ServiceStatus {
  readonly service: string;
  readonly ready: boolean;
  readonly latencyMs: number;
}

export interface DashboardData {
  systemStatus: { checkedAt: string; services: ServiceStatus[] };
  featureFlags: { degraded: boolean; flags: { key: string; enabled: boolean }[] };
  stations: Station[];
}

export interface ActiveSessionsData {
  chargingSessions: {
    items: {
      sessionId: string;
      connectorId: string;
      energyDeliveredKwh: number | null;
      requestedEnergyKwh: number;
    }[];
  };
}

export const DASHBOARD_QUERY: TypedDocumentNode<DashboardData, { city: string }> = gql`
  query Dashboard($city: String!) {
    systemStatus {
      checkedAt
      services {
        service
        ready
        latencyMs
      }
    }
    featureFlags {
      degraded
      flags {
        key
        enabled
      }
    }
    stations(city: $city) {
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
  }
`;

export const ACTIVE_SESSIONS_QUERY: TypedDocumentNode<ActiveSessionsData, { stationId: string }> =
  gql`
    query ActiveSessions($stationId: ID!) {
      chargingSessions(stationId: $stationId, active: true, first: 50) {
        items {
          sessionId
          connectorId
          energyDeliveredKwh
          requestedEnergyKwh
        }
      }
    }
  `;

export function useDashboard(city: string) {
  const polling = usePolling();
  const result = useQuery(DASHBOARD_QUERY, { variables: { city }, ...polling });
  return {
    data: result.data,
    loading: result.loading,
    error: result.error,
    refetch: result.refetch,
  };
}

export function useActiveSessions(stationId: string) {
  const polling = usePolling();
  const result = useQuery(ACTIVE_SESSIONS_QUERY, { variables: { stationId }, ...polling });
  return {
    sessions: result.data?.chargingSessions.items,
    loading: result.loading,
    error: result.error,
  };
}
