import {
  ConfigValidationError,
  loadBaseConfig,
  parseEnv,
  type BaseConfig,
  type EnvSource,
} from '@aegisvolt/config';
import { resolveFeatureFlagsTable } from '@aegisvolt/feature-flags';
import { z } from 'zod';

export const SERVICE_NAME = 'graphql-api';
export const DEFAULT_PORT = 4000;

const ms = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const serviceEnvSchema = z.object({
  /**
   * Opcional: por defecto `aegisvolt-feature-flags-<APP_ENV>`. En dev/test/prod
   * solo se admite exactamente esa tabla (ADR-0025).
   */
  FEATURE_FLAGS_TABLE_NAME: z.string().optional(),
  FEATURE_FLAGS_CACHE_TTL_MS: ms(0, 60_000, 5_000),
  DYNAMODB_CONNECTION_TIMEOUT_MS: ms(50, 10_000, 1_000),
  DYNAMODB_REQUEST_TIMEOUT_MS: ms(50, 10_000, 2_000),
  DYNAMODB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
});

export interface ServiceConfig extends BaseConfig {
  readonly featureFlags: { readonly tableName: string; readonly cacheTtlMs: number };
  readonly dynamodb: {
    readonly connectionTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maxAttempts: number;
  };
}

/**
 * El ambiente (`APP_ENV`) lo inyecta el despliegue (overlay de Kubernetes) y
 * determina la tabla de flags: ningún cliente puede elegir otro ambiente.
 */
export function loadServiceConfig(env: EnvSource): ServiceConfig {
  const base = loadBaseConfig(env, { serviceName: SERVICE_NAME, defaultPort: DEFAULT_PORT });
  const service = parseEnv(serviceEnvSchema, env);
  if (base.appEnv === 'local' && base.aws.endpointUrl === undefined) {
    throw new ConfigValidationError([
      { variable: 'AWS_ENDPOINT_URL', message: 'obligatorio con APP_ENV=local (p. ej. Floci)' },
    ]);
  }
  let tableName: string;
  try {
    tableName = resolveFeatureFlagsTable(base.appEnv, service.FEATURE_FLAGS_TABLE_NAME);
  } catch (error) {
    throw new ConfigValidationError([
      { variable: 'FEATURE_FLAGS_TABLE_NAME', message: (error as Error).message },
    ]);
  }
  return {
    ...base,
    featureFlags: { tableName, cacheTtlMs: service.FEATURE_FLAGS_CACHE_TTL_MS },
    dynamodb: {
      connectionTimeoutMs: service.DYNAMODB_CONNECTION_TIMEOUT_MS,
      requestTimeoutMs: service.DYNAMODB_REQUEST_TIMEOUT_MS,
      maxAttempts: service.DYNAMODB_MAX_ATTEMPTS,
    },
  };
}
