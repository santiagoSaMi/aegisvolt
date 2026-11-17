import { FEATURE_FLAG_CATALOG } from '@aegisvolt/feature-flags';

import { ActorId, FeatureFlagKey, type FeatureFlag } from '../../domain/index.ts';
import { flagsPolicy, type Principal } from '../authorization.ts';
import {
  ConcurrentModificationError,
  FeatureFlagNotFoundError,
  FeatureFlagVersionConflictError,
} from '../errors.ts';
import type { FlagSnapshotCache } from '../flag-snapshot-cache.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type {
  AuditedFlagChange,
  Clock,
  DeploymentEnvironment,
  FeatureFlagRepository,
} from '../ports/feature-flags.ts';

const CATALOG_KEYS = FEATURE_FLAG_CATALOG.map((d) => FeatureFlagKey.parse(d.key));

export type FlagSource = 'STORE' | 'LAST_KNOWN' | 'DEFAULT';

export interface FlagReading {
  readonly key: FeatureFlagKey;
  readonly enabled: boolean;
  readonly description: string;
  readonly source: FlagSource;
  readonly version?: number;
  readonly updatedAt?: Date;
  readonly updatedBy?: ActorId;
}

export interface FeatureFlagsSnapshot {
  readonly environment: DeploymentEnvironment;
  readonly flags: readonly FlagReading[];
  /** true si algún valor no viene de la tabla del ambiente. */
  readonly degraded: boolean;
  readonly readAt: Date;
}

interface Deps {
  readonly flags: FeatureFlagRepository;
  readonly cache: FlagSnapshotCache;
  readonly clock: Clock;
  /** Ambiente del despliegue (APP_ENV): fijo para el proceso. */
  readonly environment: DeploymentEnvironment;
}

/**
 * `GetFeatureFlags`: estado de TODAS las flags del catálogo en el ambiente del
 * despliegue (no recibe ambiente). Lectura con caché corta. Si la tabla no
 * responde, devuelve el último valor conocido o el valor seguro del catálogo,
 * marcando la respuesta como degradada: nunca inventa un `true`.
 */
export class GetFeatureFlags {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async execute(principal: Principal | undefined): Promise<FeatureFlagsSnapshot> {
    flagsPolicy.assertCanRead(principal);
    const readAt = this.deps.clock.now();
    const cached = this.deps.cache.fresh();
    if (cached !== undefined) {
      return this.snapshot(cached, 'STORE', readAt);
    }
    try {
      const stored = await this.deps.flags.findMany(CATALOG_KEYS);
      this.deps.cache.store(stored);
      return this.snapshot(stored, 'STORE', readAt);
    } catch {
      const lastKnown = this.deps.cache.stale();
      return this.snapshot(lastKnown ?? [], 'LAST_KNOWN', readAt, true);
    }
  }

  private snapshot(
    stored: readonly FeatureFlag[],
    source: FlagSource,
    readAt: Date,
    failed = false,
  ): FeatureFlagsSnapshot {
    const flags = FEATURE_FLAG_CATALOG.map((definition): FlagReading => {
      const flag = stored.find((f) => f.key === definition.key);
      if (flag === undefined) {
        return {
          key: FeatureFlagKey.parse(definition.key),
          enabled: definition.safeDefault,
          description: definition.description,
          source: 'DEFAULT',
        };
      }
      return {
        key: flag.key,
        enabled: flag.enabled,
        description: flag.description,
        source,
        version: flag.version,
        updatedAt: flag.updatedAt,
        updatedBy: flag.updatedBy,
      };
    });
    return {
      environment: this.deps.environment,
      flags,
      degraded: failed || flags.some((f) => f.source !== 'STORE'),
      readAt,
    };
  }
}

export interface UpdateFeatureFlagCommand {
  readonly key: string;
  readonly enabled: boolean;
  /** Si se envía y no coincide con la versión actual → FEATURE_FLAG_VERSION_CONFLICT. */
  readonly expectedVersion?: number | undefined;
  /** `correlation_id` de la petición (queda en la auditoría). */
  readonly correlationId: string;
}

export interface UpdateFeatureFlagResult {
  readonly flag: FeatureFlag;
  /** false: ya tenía ese valor (sin escritura ni auditoría). */
  readonly changed: boolean;
  readonly change?: AuditedFlagChange;
}

/**
 * `UpdateFeatureFlag`: solo `platform-admins`. Cambia una flag del catálogo en la
 * tabla del ambiente del despliegue, con versión condicional y auditoría (quién,
 * cuándo, qué, `correlation_id`, ambiente) en la MISMA transacción. Invalida la
 * caché local; las demás réplicas y servicios lo ven al vencer su TTL. No
 * requiere redesplegar nada.
 */
export class UpdateFeatureFlag {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async execute(
    principal: Principal | undefined,
    command: UpdateFeatureFlagCommand,
  ): Promise<UpdateFeatureFlagResult> {
    const admin = flagsPolicy.assertCanWrite(principal);
    const actor = ActorId.parse(admin.subject);
    const key = FeatureFlagKey.parse(command.key);
    if (!CATALOG_KEYS.includes(key)) {
      throw new FeatureFlagNotFoundError(`La flag ${key} no está en el catálogo`);
    }

    const result = await withOptimisticRetry(async () => {
      const current = await this.deps.flags.find(key);
      if (current === undefined) {
        throw new FeatureFlagNotFoundError(
          `La flag ${key} no existe en el ambiente ${this.deps.environment} (no sembrada)`,
        );
      }
      if (command.expectedVersion !== undefined && command.expectedVersion !== current.version) {
        throw new FeatureFlagVersionConflictError(
          `La flag ${key} está en la versión ${String(current.version)}, no en ${String(command.expectedVersion)}`,
        );
      }
      const { flag, change } = current.setEnabled(command.enabled, actor, this.deps.clock.now());
      if (change === undefined) {
        return { flag, changed: false };
      }
      const audited: AuditedFlagChange = {
        ...change,
        correlationId: command.correlationId,
        environment: this.deps.environment,
      };
      try {
        await this.deps.flags.saveChange({
          flag,
          expectedVersion: current.version,
          change: audited,
        });
      } catch (error) {
        // Con versión esperada explícita no se reintenta: el cliente decide.
        if (error instanceof ConcurrentModificationError && command.expectedVersion !== undefined) {
          throw new FeatureFlagVersionConflictError(`La flag ${key} cambió durante la escritura`, {
            cause: error,
          });
        }
        throw error;
      }
      return { flag, changed: true, change: audited };
    });
    if (result.changed) {
      this.deps.cache.invalidate();
    }
    return result;
  }
}

/** Auditoría de una flag (solo `platform-admins`). */
export class ListFeatureFlagChanges {
  private readonly flags: FeatureFlagRepository;

  constructor(deps: { flags: FeatureFlagRepository }) {
    this.flags = deps.flags;
  }

  async execute(
    principal: Principal | undefined,
    query: { key: string; limit: number },
  ): Promise<readonly AuditedFlagChange[]> {
    flagsPolicy.assertCanWrite(principal);
    const key = FeatureFlagKey.parse(query.key);
    if (!CATALOG_KEYS.includes(key)) {
      throw new FeatureFlagNotFoundError(`La flag ${key} no está en el catálogo`);
    }
    return this.flags.listChanges(key, query.limit);
  }
}
