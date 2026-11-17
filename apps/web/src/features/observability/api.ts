import { gql, type TypedDocumentNode } from '@apollo/client';
import { skipToken, useQuery } from '@apollo/client/react';

import { usePolling } from '../../shared/hooks/usePolling.ts';
import { SAGA_FIELDS } from '../charging/api.ts';
import type { Saga } from '../charging/model.ts';

export interface SagaEvent {
  readonly sequence: number;
  readonly type: string;
  readonly step: string | null;
  readonly status: string;
  readonly attempt: number | null;
  readonly errorCode: string | null;
  readonly occurredAt: string;
}

export type SagaWithEvents = Saga & { readonly events: readonly SagaEvent[] };

export const FLEET_SAGAS_QUERY: TypedDocumentNode<
  { sagas: Saga[] },
  { fleetId: string; status?: string; first: number }
> = gql`
  ${SAGA_FIELDS}
  query FleetSagas($fleetId: ID, $status: SagaStatus, $first: Int) {
    sagas(fleetId: $fleetId, status: $status, first: $first) {
      ...SagaFields
    }
  }
`;

export const SAGA_HISTORY_QUERY: TypedDocumentNode<
  { sagaStatus: SagaWithEvents | null },
  { sagaId: string }
> = gql`
  ${SAGA_FIELDS}
  query SagaHistory($sagaId: ID!) {
    sagaStatus(sagaId: $sagaId) {
      ...SagaFields
      events {
        sequence
        type
        step
        status
        attempt
        errorCode
        occurredAt
      }
    }
  }
`;

export function useFleetSagas(fleetId: string | undefined, status: string | undefined) {
  const polling = usePolling();
  const result = useQuery(
    FLEET_SAGAS_QUERY,
    fleetId === undefined
      ? skipToken
      : {
          variables: { fleetId, first: 50, ...(status === undefined ? {} : { status }) },
          ...polling,
        },
  );
  return {
    sagas: result.data?.sagas,
    loading: result.loading,
    error: result.error,
    refetch: result.refetch,
  };
}

export function useSagaHistory(sagaId: string | undefined) {
  const polling = usePolling();
  const result = useQuery(
    SAGA_HISTORY_QUERY,
    sagaId === undefined ? skipToken : { variables: { sagaId }, ...polling },
  );
  return { saga: result.data?.sagaStatus, loading: result.loading, error: result.error };
}
