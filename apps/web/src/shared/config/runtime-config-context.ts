import { createContext, useContext } from 'react';

import type { RuntimeConfig } from '../../config/runtime-config.ts';

export const RuntimeConfigContext = createContext<RuntimeConfig | undefined>(undefined);

/** Configuración del despliegue (solo lectura; no hay forma de cambiarla desde la UI). */
export function useRuntimeConfig(): RuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (config === undefined) {
    throw new Error('useRuntimeConfig requiere RuntimeConfigProvider');
  }
  return config;
}
