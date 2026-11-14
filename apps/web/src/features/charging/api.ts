import { gql, type TypedDocumentNode } from '@apollo/client';
import { skipToken, useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';

import { usePolling } from '../../shared/hooks/usePolling.ts';
import type { ChargingEstimate, Saga } from './model.ts';

export const SAGA_FIELDS = gql`
  fragment SagaFields on Saga {
    sagaId
    status
    terminal
    fleetId
    stationId
    connectorId
    requestedEnergyKwh
    correlationId
    reservationId
    debitId
    sessionId
    failureReason
    compensationPlan
    compensationFailure {
      step
      errorCode
      nextAttemptAt
    }
    steps {
      step
      status
      attempts
      lastErrorCode
    }
    createdAt
    updatedAt
  }
`;

export interface AvailableConnector {
  readonly connector: { connectorId: string; type: string; maxPowerKw: number; ultraFast: boolean };
}

export interface ChargingEstimateVariables {
  fleetId?: string | undefined;
  stationId: string;
  connectorId: string;
  energyKwh: number;
}

export const AVAILABLE_CONNECTORS_QUERY: TypedDocumentNode<
  { availableConnectors: AvailableConnector[] },
  { stationId: string }
> = gql`
  query AvailableConnectors($stationId: ID!) {
    availableConnectors(stationId: $stationId) {
      connector {
        connectorId
        type
        maxPowerKw
        ultraFast
      }
    }
  }
`;

export const CHARGING_ESTIMATE_QUERY: TypedDocumentNode<
  { chargingEstimate: ChargingEstimate },
  ChargingEstimateVariables
> = gql`
  query ChargingEstimate($fleetId: ID, $stationId: ID!, $connectorId: ID!, $energyKwh: Float!) {
    chargingEstimate(
      fleetId: $fleetId
      stationId: $stationId
      connectorId: $connectorId
      requestedEnergyKwh: $energyKwh
    ) {
      connectorPowerKw
      estimated {
        amountMinor
        currency
      }
      available {
        amountMinor
        currency
      }
      sufficient
      tariffMinorPerKwh
      surgeApplied
      surgeMultiplierBasisPoints
    }
  }
`;

export const RESERVE_AND_ACTIVATE_MUTATION: TypedDocumentNode<
  { reserveAndActivateCharging: { finished: boolean; saga: Saga } },
  { input: Record<string, unknown> }
> = gql`
  ${SAGA_FIELDS}
  mutation ReserveAndActivateCharging($input: ReserveAndActivateChargingInput!) {
    reserveAndActivateCharging(input: $input) {
      finished
      saga {
        ...SagaFields
      }
    }
  }
`;

export const SAGA_STATUS_QUERY: TypedDocumentNode<{ sagaStatus: Saga | null }, { sagaId: string }> =
  gql`
    ${SAGA_FIELDS}
    query SagaStatus($sagaId: ID!) {
      sagaStatus(sagaId: $sagaId) {
        ...SagaFields
      }
    }
  `;

export function useAvailableConnectors(stationId: string | undefined) {
  const polling = usePolling();
  const result = useQuery(
    AVAILABLE_CONNECTORS_QUERY,
    stationId === undefined || stationId === ''
      ? skipToken
      : { variables: { stationId }, ...polling },
  );
  return {
    connectors: result.data?.availableConnectors,
    loading: result.loading,
    error: result.error,
  };
}

/** Estimación del backend (billing) para la entrada ya validada; se omite si no hay entrada. */
export function useChargingEstimate(input: ChargingEstimateVariables | undefined) {
  const result = useQuery(
    CHARGING_ESTIMATE_QUERY,
    input === undefined ? skipToken : { variables: input, fetchPolicy: 'network-only' },
  );
  return { estimate: result.data?.chargingEstimate, loading: result.loading, error: result.error };
}

export function useReserveAndActivateMutation() {
  return useMutation(RESERVE_AND_ACTIVATE_MUTATION);
}

/**
 * Seguimiento de una SAGA por polling hasta un estado terminal. No hay
 * suscripción en tiempo real: el estado se consulta cada `pollingIntervalMs`.
 * Si la mutación ya devolvió una SAGA terminal, no se consulta nada más.
 */
export function useSagaTracking(sagaId: string, initial: Saga) {
  const [done, setDone] = useState(initial.terminal);
  const polling = usePolling(!done);
  const result = useQuery(
    SAGA_STATUS_QUERY,
    initial.terminal ? skipToken : { variables: { sagaId }, ...polling },
  );
  const saga = result.data?.sagaStatus ?? initial;
  // Estado derivado del render anterior (patrón documentado por React): al llegar
  // a un estado terminal se detiene el polling en el siguiente render.
  if (saga.terminal && !done) {
    setDone(true);
  }
  return { saga, polling: !done, error: result.error };
}
