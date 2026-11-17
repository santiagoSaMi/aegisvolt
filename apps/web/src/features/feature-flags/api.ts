import { gql, type TypedDocumentNode } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';

import { usePolling } from '../../shared/hooks/usePolling.ts';

export interface FeatureFlag {
  readonly key: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly source: 'STORE' | 'LAST_KNOWN' | 'DEFAULT';
  readonly version: number | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface FeatureFlagsData {
  featureFlags: { environment: string; degraded: boolean; readAt: string; flags: FeatureFlag[] };
}

export interface UpdateFeatureFlagData {
  updateFeatureFlag: {
    changed: boolean;
    flag: FeatureFlag;
    change: { correlationId: string } | null;
  };
}

export const FEATURE_FLAGS_QUERY: TypedDocumentNode<FeatureFlagsData, Record<string, never>> = gql`
  query FeatureFlags {
    featureFlags {
      environment
      degraded
      readAt
      flags {
        key
        enabled
        description
        source
        version
        updatedAt
        updatedBy
      }
    }
  }
`;

export const UPDATE_FEATURE_FLAG_MUTATION: TypedDocumentNode<
  UpdateFeatureFlagData,
  { input: { key: string; enabled: boolean; expectedVersion?: number } }
> = gql`
  mutation UpdateFeatureFlag($input: UpdateFeatureFlagInput!) {
    updateFeatureFlag(input: $input) {
      changed
      flag {
        key
        enabled
        description
        source
        version
        updatedAt
        updatedBy
      }
      change {
        from
        to
        changedBy
        changedAt
        correlationId
        environment
      }
    }
  }
`;

export function useFeatureFlags() {
  const polling = usePolling();
  const result = useQuery(FEATURE_FLAGS_QUERY, polling);
  return {
    data: result.data?.featureFlags,
    loading: result.loading,
    error: result.error,
    refetch: result.refetch,
  };
}

export function useUpdateFeatureFlagMutation() {
  return useMutation(UPDATE_FEATURE_FLAG_MUTATION, { refetchQueries: [FEATURE_FLAGS_QUERY] });
}
