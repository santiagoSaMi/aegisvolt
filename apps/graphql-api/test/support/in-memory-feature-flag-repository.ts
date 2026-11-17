import { FEATURE_FLAG_CATALOG, type FlagEnvironment } from '@aegisvolt/feature-flags';

import {
  ConcurrentModificationError,
  DependencyUnavailableError,
  type AuditedFlagChange,
  type Clock,
  type FeatureFlagRepository,
} from '../../src/application/index.ts';
import { ActorId, FeatureFlag, FeatureFlagKey } from '../../src/domain/index.ts';

/**
 * Tabla de flags en memoria de UN ambiente, con las mismas condiciones que el
 * adaptador DynamoDB (versión leída; flag + auditoría todo o nada).
 */
export class InMemoryFeatureFlagRepository implements FeatureFlagRepository {
  readonly flags = new Map<string, FeatureFlag>();
  readonly audit: AuditedFlagChange[] = [];
  reads = 0;
  unavailable = false;
  /** Se ejecuta antes de cada escritura (inyección de concurrencia). */
  beforeSave: (() => void) | undefined;

  /** Siembra el catálogo con los valores iniciales del ambiente (como Terraform). */
  static seeded(environment: FlagEnvironment, now: Date): InMemoryFeatureFlagRepository {
    const repo = new InMemoryFeatureFlagRepository();
    for (const definition of FEATURE_FLAG_CATALOG) {
      repo.flags.set(
        definition.key,
        FeatureFlag.define({
          key: FeatureFlagKey.parse(definition.key),
          enabled: definition.initial[environment],
          description: definition.description,
          definedBy: ActorId.parse('seed'),
          now,
        }),
      );
    }
    return repo;
  }

  findMany(keys: readonly FeatureFlagKey[]): Promise<readonly FeatureFlag[]> {
    this.reads++;
    if (this.unavailable) {
      return Promise.reject(new DependencyUnavailableError('DynamoDB no disponible'));
    }
    return Promise.resolve(
      keys.map((key) => this.flags.get(key)).filter((f): f is FeatureFlag => f !== undefined),
    );
  }

  find(key: FeatureFlagKey): Promise<FeatureFlag | undefined> {
    if (this.unavailable) {
      return Promise.reject(new DependencyUnavailableError('DynamoDB no disponible'));
    }
    return Promise.resolve(this.flags.get(key));
  }

  saveChange(input: {
    flag: FeatureFlag;
    expectedVersion: number;
    change: AuditedFlagChange;
  }): Promise<void> {
    this.beforeSave?.();
    if (this.flags.get(input.flag.key)?.version !== input.expectedVersion) {
      return Promise.reject(new ConcurrentModificationError('versión distinta'));
    }
    this.flags.set(input.flag.key, input.flag);
    this.audit.push(input.change);
    return Promise.resolve();
  }

  listChanges(key: FeatureFlagKey, limit: number): Promise<readonly AuditedFlagChange[]> {
    return Promise.resolve(
      this.audit
        .filter((c) => c.key === key)
        .reverse()
        .slice(0, limit),
    );
  }
}

export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
