import type { FeatureFlag, FeatureFlagKey, FlagChange } from '../../domain/index.ts';

/** Ambiente del DESPLIEGUE que ejecuta el caso de uso (configuración confiable). */
export type DeploymentEnvironment = 'local' | 'dev' | 'test' | 'prod';

/** Cambio auditado: quién, cuándo, qué, con qué `correlation_id` y en qué ambiente. */
export interface AuditedFlagChange extends FlagChange {
  readonly correlationId: string;
  readonly environment: DeploymentEnvironment;
}

/**
 * Flags del ambiente (`aegisvolt-feature-flags-<env>`). El repositorio está
 * ligado a UNA tabla, la del ambiente del despliegue: no hay forma de pedirle
 * otra. Las escrituras son condicionales a la versión leída y guardan la
 * auditoría en la misma transacción; si otra escritura ganó, lanzan
 * `ConcurrentModificationError` sin escribir nada.
 */
export interface FeatureFlagRepository {
  /** Flags presentes de entre las claves pedidas (las ausentes no se devuelven). */
  findMany(keys: readonly FeatureFlagKey[]): Promise<readonly FeatureFlag[]>;
  find(key: FeatureFlagKey): Promise<FeatureFlag | undefined>;
  saveChange(input: {
    flag: FeatureFlag;
    expectedVersion: number;
    change: AuditedFlagChange;
  }): Promise<void>;
  /** Auditoría de una flag, la más reciente primero. */
  listChanges(key: FeatureFlagKey, limit: number): Promise<readonly AuditedFlagChange[]>;
}

export interface Clock {
  now(): Date;
}
