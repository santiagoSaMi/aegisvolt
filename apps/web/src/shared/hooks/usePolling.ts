import { useRuntimeConfig } from '../config/runtime-config-context.ts';

/**
 * Opciones de polling de Apollo con el intervalo del despliegue (ADR-0017). Se
 * omite el sondeo mientras la pestaña está oculta. NO hay suscripciones en
 * tiempo real: los datos se refrescan cada `pollingIntervalMs`.
 */
export function usePolling(enabled = true): {
  pollInterval: number;
  skipPollAttempt: () => boolean;
} {
  const { pollingIntervalMs } = useRuntimeConfig();
  return {
    pollInterval: enabled ? pollingIntervalMs : 0,
    skipPollAttempt: () => typeof document !== 'undefined' && document.hidden,
  };
}
