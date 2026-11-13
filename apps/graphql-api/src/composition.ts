import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  FlagSnapshotCache,
  GetFeatureFlags,
  ListFeatureFlagChanges,
  UpdateFeatureFlag,
  type Clock,
  type DeploymentEnvironment,
} from './application/index.ts';
import { DynamoDbFeatureFlagRepository } from './infrastructure/dynamodb/dynamodb-feature-flag-repository.ts';

/**
 * Casos de uso del módulo de flags ligados a la tabla y al ambiente del
 * despliegue. Lectura y escritura comparten la caché para que la réplica que
 * escribe vea su cambio de inmediato.
 */
export function createFlagUseCases(deps: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  environment: DeploymentEnvironment;
  cacheTtlMs: number;
  clock: Clock;
}) {
  const flags = new DynamoDbFeatureFlagRepository(deps.documentClient, deps.tableName);
  const cache = new FlagSnapshotCache({ ttlMs: deps.cacheTtlMs, clock: deps.clock });
  const shared = { flags, cache, clock: deps.clock, environment: deps.environment };
  return {
    getFeatureFlags: new GetFeatureFlags(shared),
    updateFeatureFlag: new UpdateFeatureFlag(shared),
    listFeatureFlagChanges: new ListFeatureFlagChanges({ flags }),
  };
}
