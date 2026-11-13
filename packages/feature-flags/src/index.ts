// Lectura de feature flags por ambiente (ADR-0007). Genérico: no contiene
// reglas de negocio; cada servicio decide qué hace con el valor de una flag.
export {
  InvalidFeatureFlagError,
  type FeatureFlagKey,
  type FeatureFlagReader,
  type FeatureFlagSource,
  type FeatureFlagState,
} from './reader.ts';
export {
  CachedFeatureFlagReader,
  DEFAULT_FLAG_CACHE_TTL_MS,
  type CachedFeatureFlagReaderOptions,
} from './cached-reader.ts';
export { DynamoDbFeatureFlagSource } from './dynamodb-source.ts';
export { featureFlagKeys, featureFlagsTableDefinition, featureFlagsTableName } from './table.ts';
