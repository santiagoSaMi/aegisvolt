import { CachedFeatureFlagReader, DynamoDbFeatureFlagSource } from '@aegisvolt/feature-flags';
import type { Logger } from '@aegisvolt/logger';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { FeatureFlagReader } from '../../application/index.ts';

/**
 * Lector de flags del ambiente (ADR-0007): `aegisvolt-feature-flags-<env>` con
 * caché corta. Solo lectura. Si el almacén falla se registra un aviso y se usa
 * el último valor conocido o `false` (sin falla simulada: el valor seguro).
 */
export function createFeatureFlagReader(deps: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  cacheTtlMs: number;
  logger: Logger;
}): FeatureFlagReader {
  return new CachedFeatureFlagReader(
    new DynamoDbFeatureFlagSource(deps.documentClient, deps.tableName),
    {
      ttlMs: deps.cacheTtlMs,
      onError: (key, error, fallback) => {
        deps.logger.warn('No se pudo leer la feature flag; se usa el valor de respaldo', {
          event: 'feature_flag_read_failed',
          flag: key,
          fallback,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      },
    },
  );
}
