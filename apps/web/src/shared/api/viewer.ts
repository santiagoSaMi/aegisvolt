import { gql, type TypedDocumentNode } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import type { RuntimeEnvironment } from '../../config/runtime-config.ts';

export interface Viewer {
  readonly subject: string;
  readonly groups: readonly string[];
  readonly fleetId: string | null;
  readonly isAdmin: boolean;
  /** Ambiente que informa el backend (APP_ENV del despliegue). */
  readonly environment: RuntimeEnvironment;
}

export const VIEWER_QUERY: TypedDocumentNode<{ viewer: Viewer }, Record<string, never>> = gql`
  query Viewer {
    viewer {
      subject
      groups
      fleetId
      isAdmin
      environment
    }
  }
`;

/** Identidad, flota, rol y ambiente según el backend (fuente de verdad). */
export function useViewer() {
  const result = useQuery(VIEWER_QUERY, { fetchPolicy: 'cache-first' });
  return { viewer: result.data?.viewer, loading: result.loading, error: result.error };
}
