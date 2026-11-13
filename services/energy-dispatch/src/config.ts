import {
  ConfigValidationError,
  loadBaseConfig,
  parseEnv,
  type BaseConfig,
  type EnvSource,
} from '@aegisvolt/config';
import { z } from 'zod';

export const SERVICE_NAME = 'energy-dispatch-service';
export const DEFAULT_PORT = 4103;

const ms = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const tableName = z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/);

const serviceEnvSchema = z.object({
  /** `aegisvolt-dispatch-<env>` (lo crea Terraform en cada ambiente). */
  DYNAMODB_TABLE_NAME: tableName,
  /** `aegisvolt-feature-flags-<env>`: solo lectura (ADR-0007). */
  FEATURE_FLAGS_TABLE_NAME: tableName,
  /** Vigencia de la caché de flags: un cambio se refleja en ≤ este tiempo. */
  FEATURE_FLAGS_CACHE_TTL_MS: ms(0, 60_000, 5_000),
  HTTP_REQUEST_TIMEOUT_MS: ms(100, 30_000, 5_000),
  DYNAMODB_CONNECTION_TIMEOUT_MS: ms(50, 10_000, 1_000),
  DYNAMODB_REQUEST_TIMEOUT_MS: ms(50, 10_000, 2_000),
  DYNAMODB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  /** Días que se conserva la telemetría (atributo `ttl`). */
  TELEMETRY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
  /** Readiness en 503 antes de cerrar el servidor (propagación a los Endpoints de Kubernetes). */
  SHUTDOWN_DRAIN_DELAY_MS: ms(0, 60_000, 0),
  /** Plazo para terminar peticiones en curso al apagar. */
  SHUTDOWN_GRACE_MS: ms(100, 120_000, 10_000),
});

export interface ServiceConfig extends BaseConfig {
  readonly http: { readonly requestTimeoutMs: number };
  readonly dynamodb: {
    readonly tableName: string;
    readonly connectionTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maxAttempts: number;
  };
  readonly featureFlags: { readonly tableName: string; readonly cacheTtlMs: number };
  readonly telemetry: { readonly retentionDays: number };
  readonly shutdown: { readonly drainDelayMs: number; readonly graceMs: number };
}

export function loadServiceConfig(env: EnvSource): ServiceConfig {
  const base = loadBaseConfig(env, { serviceName: SERVICE_NAME, defaultPort: DEFAULT_PORT });
  const service = parseEnv(serviceEnvSchema, env);

  // En local el endpoint debe ser explícito (Floci): nunca se cae por defecto en AWS real.
  if (base.appEnv === 'local' && base.aws.endpointUrl === undefined) {
    throw new ConfigValidationError([
      { variable: 'AWS_ENDPOINT_URL', message: 'obligatorio con APP_ENV=local (p. ej. Floci)' },
    ]);
  }
  // El presupuesto de DynamoDB (timeout × intentos) debe caber en el de la petición HTTP.
  if (
    service.DYNAMODB_REQUEST_TIMEOUT_MS * service.DYNAMODB_MAX_ATTEMPTS >=
    service.HTTP_REQUEST_TIMEOUT_MS
  ) {
    throw new ConfigValidationError([
      {
        variable: 'HTTP_REQUEST_TIMEOUT_MS',
        message: 'debe superar DYNAMODB_REQUEST_TIMEOUT_MS × DYNAMODB_MAX_ATTEMPTS',
      },
    ]);
  }
  // Las peticiones en curso deben poder terminar dentro del plazo de apagado.
  if (service.SHUTDOWN_GRACE_MS <= service.HTTP_REQUEST_TIMEOUT_MS) {
    throw new ConfigValidationError([
      { variable: 'SHUTDOWN_GRACE_MS', message: 'debe superar HTTP_REQUEST_TIMEOUT_MS' },
    ]);
  }

  return {
    ...base,
    http: { requestTimeoutMs: service.HTTP_REQUEST_TIMEOUT_MS },
    dynamodb: {
      tableName: service.DYNAMODB_TABLE_NAME,
      connectionTimeoutMs: service.DYNAMODB_CONNECTION_TIMEOUT_MS,
      requestTimeoutMs: service.DYNAMODB_REQUEST_TIMEOUT_MS,
      maxAttempts: service.DYNAMODB_MAX_ATTEMPTS,
    },
    featureFlags: {
      tableName: service.FEATURE_FLAGS_TABLE_NAME,
      cacheTtlMs: service.FEATURE_FLAGS_CACHE_TTL_MS,
    },
    telemetry: { retentionDays: service.TELEMETRY_RETENTION_DAYS },
    shutdown: {
      drainDelayMs: service.SHUTDOWN_DRAIN_DELAY_MS,
      graceMs: service.SHUTDOWN_GRACE_MS,
    },
  };
}
