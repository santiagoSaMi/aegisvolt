import { featureFlagsTableName } from './table.ts';

/** Ambientes desplegados: su tabla de flags está fijada y no se puede sustituir. */
const DEPLOYED_ENVIRONMENTS = new Set(['dev', 'test', 'prod']);
const LOCAL_TABLE_PATTERN = /^aegisvolt-feature-flags-[a-z0-9][a-z0-9-]{0,62}$/;

export class FeatureFlagsTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureFlagsTableError';
  }
}

/**
 * Tabla de flags de un proceso, derivada del AMBIENTE DEL DESPLIEGUE (`APP_ENV`,
 * que fija el overlay de Kubernetes), nunca de algo que envíe un cliente.
 *
 * - `dev`/`test`/`prod`: siempre `aegisvolt-feature-flags-<env>`. Un override
 *   distinto (p. ej. un pod de `dev` apuntando a la tabla de `prod`) es un error de
 *   configuración que impide arrancar.
 * - `local`: por defecto `aegisvolt-feature-flags-local`; se admite otra tabla con
 *   el mismo prefijo para pruebas (tablas temporales en Floci).
 */
export function resolveFeatureFlagsTable(appEnv: string, override: string | undefined): string {
  const expected = featureFlagsTableName(appEnv);
  if (override === undefined || override === '') {
    return expected;
  }
  if (DEPLOYED_ENVIRONMENTS.has(appEnv)) {
    if (override !== expected) {
      throw new FeatureFlagsTableError(
        `en ${appEnv} la tabla de flags debe ser ${expected} (se recibió ${override})`,
      );
    }
    return override;
  }
  if (!LOCAL_TABLE_PATTERN.test(override)) {
    throw new FeatureFlagsTableError('debe empezar por aegisvolt-feature-flags-');
  }
  return override;
}
