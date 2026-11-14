import type { ServiceStatus } from './api.ts';

export type SystemHealth = 'OPERATIONAL' | 'DEGRADED' | 'DOWN';

/** Estado global a partir de la readiness de cada servicio y de las flags. */
export function systemHealth(
  services: readonly ServiceStatus[],
  flagsDegraded: boolean,
): SystemHealth {
  const down = services.filter((s) => !s.ready).length;
  if (services.length > 0 && down === services.length) {
    return 'DOWN';
  }
  return down > 0 || flagsDegraded ? 'DEGRADED' : 'OPERATIONAL';
}

export const HEALTH_LABEL: Record<
  SystemHealth,
  { label: string; tone: 'success' | 'warning' | 'danger' }
> = {
  OPERATIONAL: { label: 'Operativo', tone: 'success' },
  DEGRADED: { label: 'Degradado', tone: 'warning' },
  DOWN: { label: 'Sin servicio', tone: 'danger' },
};
