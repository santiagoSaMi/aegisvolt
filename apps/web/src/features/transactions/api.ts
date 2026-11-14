import { gql, type TypedDocumentNode } from '@apollo/client';
import { skipToken, useQuery } from '@apollo/client/react';

import { usePolling } from '../../shared/hooks/usePolling.ts';

export interface Transaction {
  readonly transactionId: string;
  readonly type: 'DEBIT' | 'REFUND' | 'TOP_UP';
  readonly amount: { amountMinor: number; currency: string };
  readonly balanceAfter: { amountMinor: number; currency: string };
  readonly sagaId: string | null;
  readonly debitId: string | null;
  readonly correlationId: string;
  readonly occurredAt: string;
}

export interface SagaSummary {
  readonly sagaId: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly correlationId: string;
  readonly compensationPlan: readonly string[];
  readonly stationId: string;
  readonly connectorId: string;
  readonly createdAt: string;
}

interface Money {
  amountMinor: number;
  currency: string;
}

export interface TransactionsData {
  walletBalance: { fleetId: string; balance: Money };
  transactions: {
    items: Transaction[];
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
  sagas: SagaSummary[];
}

export const TRANSACTIONS_QUERY: TypedDocumentNode<
  TransactionsData,
  { fleetId: string; first: number; after?: string }
> = gql`
  query Transactions($fleetId: ID, $first: Int, $after: String) {
    walletBalance(fleetId: $fleetId) {
      fleetId
      balance {
        amountMinor
        currency
      }
    }
    transactions(fleetId: $fleetId, first: $first, after: $after) {
      items {
        transactionId
        type
        amount {
          amountMinor
          currency
        }
        balanceAfter {
          amountMinor
          currency
        }
        sagaId
        debitId
        correlationId
        occurredAt
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
    sagas(fleetId: $fleetId, first: 50) {
      sagaId
      status
      failureReason
      correlationId
      compensationPlan
      stationId
      connectorId
      createdAt
    }
  }
`;

export function useTransactions(fleetId: string | undefined, pageSize = 20) {
  const polling = usePolling();
  const result = useQuery(
    TRANSACTIONS_QUERY,
    fleetId === undefined ? skipToken : { variables: { fleetId, first: pageSize }, ...polling },
  );
  const loadMore = () => {
    const cursor = result.data?.transactions.pageInfo.endCursor;
    if (cursor === null || cursor === undefined) {
      return;
    }
    void result.fetchMore({
      variables: { after: cursor },
      updateQuery: (previous, { fetchMoreResult }) => ({
        ...fetchMoreResult,
        transactions: {
          items: [...previous.transactions.items, ...fetchMoreResult.transactions.items],
          pageInfo: fetchMoreResult.transactions.pageInfo,
        },
      }),
    });
  };
  return {
    data: result.data,
    loading: result.loading,
    error: result.error,
    refetch: result.refetch,
    loadMore,
  };
}
