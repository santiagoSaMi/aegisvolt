import { useRef, useState } from 'react';

import { toUiError, type UiError } from '../../shared/api/errors.ts';
import { useReserveAndActivateMutation } from './api.ts';
import type { ChargingInput, Saga } from './model.ts';

/**
 * Inicia la SAGA. La `idempotencyKey` se genera UNA vez por intento del usuario y
 * se reutiliza si reintenta tras un error de red: el backend devuelve la misma
 * SAGA y nunca cobra dos veces. Un intento nuevo (otra entrada) usa otra clave.
 */
export function useStartCharging() {
  const [mutate, { loading }] = useReserveAndActivateMutation();
  const [saga, setSaga] = useState<Saga | undefined>();
  const [error, setError] = useState<UiError | undefined>();
  const attempt = useRef<{ key: string; signature: string } | undefined>(undefined);

  const start = async (input: ChargingInput) => {
    const signature = JSON.stringify(input);
    if (attempt.current?.signature !== signature) {
      attempt.current = { key: crypto.randomUUID(), signature };
    }
    setError(undefined);
    try {
      const result = await mutate({
        variables: {
          input: {
            idempotencyKey: attempt.current.key,
            stationId: input.stationId,
            connectorId: input.connectorId,
            requestedEnergyKwh: input.energyKwh,
            ...(input.fleetId === undefined || input.fleetId === ''
              ? {}
              : { fleetId: input.fleetId }),
          },
        },
      });
      const started = result.data?.reserveAndActivateCharging.saga;
      if (started !== undefined) {
        setSaga(started);
        attempt.current = undefined;
      }
    } catch (caught) {
      setError(toUiError(caught));
    }
  };

  const reset = () => {
    setSaga(undefined);
    setError(undefined);
    attempt.current = undefined;
  };

  return { start, starting: loading, saga, error, reset };
}
