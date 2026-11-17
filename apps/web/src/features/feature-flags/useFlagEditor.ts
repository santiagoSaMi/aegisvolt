import { useState } from 'react';

import { toUiError, type UiError } from '../../shared/api/errors.ts';
import { useUpdateFeatureFlagMutation, type FeatureFlag } from './api.ts';

export interface PendingChange {
  readonly flag: FeatureFlag;
  readonly enabled: boolean;
}

/**
 * Edición de una flag con confirmación explícita y concurrencia optimista
 * (`expectedVersion`): si otro administrador la cambió, el backend responde
 * CONFLICT y la lista se refresca. La autorización la decide el backend.
 */
export function useFlagEditor() {
  const [mutate, { loading }] = useUpdateFeatureFlagMutation();
  const [pending, setPending] = useState<PendingChange | undefined>();
  const [error, setError] = useState<UiError | undefined>();
  const [lastResult, setLastResult] = useState<
    { key: string; correlationId: string | undefined } | undefined
  >();

  const request = (flag: FeatureFlag, enabled: boolean) => {
    setError(undefined);
    setPending({ flag, enabled });
  };
  const cancel = () => {
    setPending(undefined);
  };
  const confirm = async () => {
    if (pending === undefined) {
      return;
    }
    try {
      const result = await mutate({
        variables: {
          input: {
            key: pending.flag.key,
            enabled: pending.enabled,
            ...(pending.flag.version === null ? {} : { expectedVersion: pending.flag.version }),
          },
        },
      });
      setLastResult({
        key: pending.flag.key,
        correlationId: result.data?.updateFeatureFlag.change?.correlationId,
      });
    } catch (caught) {
      setError(toUiError(caught));
    } finally {
      setPending(undefined);
    }
  };

  return { pending, saving: loading, error, lastResult, request, cancel, confirm };
}
