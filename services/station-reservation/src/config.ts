import {
  ConfigValidationError,
  loadBaseConfig,
  parseEnv,
  type BaseConfig,
  type EnvSource,
} from '@aegisvolt/config';
import { z } from 'zod';

export const SERVICE_NAME = 'station-reservation-service';
export const DEFAULT_PORT = 4101;

const ms = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const serviceEnvSchema = z.object({
  /** `aegisvolt-reservations-<env>` (lo crea Terraform en cada ambiente). */
  DYNAMODB_TABLE_NAME: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
  HTTP_REQUEST_TIMEOUT_MS: ms(100, 30_000, 5_000),
  DYNAMODB_CONNECTION_TIMEOUT_MS: ms(50, 10_000, 1_000),
  DYNAMODB_REQUEST_TIMEOUT_MS: ms(50, 10_000, 2_000),
  DYNAMODB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  RESERVATION_STANDARD_HOLD_MS: ms(1_000, 3_600_000, 120_000),
  RESERVATION_BOOSTED_HOLD_MS: ms(1_000, 3_600_000, 300_000),
  /** Provisional hasta el lector de flags en DynamoDB (ADR-0007). */
  FEATURE_ENABLE_FAST_CHARGE_BOOST: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export interface ServiceConfig extends BaseConfig {
  readonly http: { readonly requestTimeoutMs: number };
  readonly dynamodb: {
    readonly tableName: string;
    readonly connectionTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maxAttempts: number;
  };
  readonly reservationPolicy: { readonly standardHoldMs: number; readonly boostedHoldMs: number };
  readonly featureFlags: { readonly ENABLE_FAST_CHARGE_BOOST: boolean };
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

  return {
    ...base,
    http: { requestTimeoutMs: service.HTTP_REQUEST_TIMEOUT_MS },
    dynamodb: {
      tableName: service.DYNAMODB_TABLE_NAME,
      connectionTimeoutMs: service.DYNAMODB_CONNECTION_TIMEOUT_MS,
      requestTimeoutMs: service.DYNAMODB_REQUEST_TIMEOUT_MS,
      maxAttempts: service.DYNAMODB_MAX_ATTEMPTS,
    },
    reservationPolicy: {
      standardHoldMs: service.RESERVATION_STANDARD_HOLD_MS,
      boostedHoldMs: service.RESERVATION_BOOSTED_HOLD_MS,
    },
    featureFlags: { ENABLE_FAST_CHARGE_BOOST: service.FEATURE_ENABLE_FAST_CHARGE_BOOST },
  };
}
