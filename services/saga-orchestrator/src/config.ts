import {
  ConfigValidationError,
  loadBaseConfig,
  parseEnv,
  type BaseConfig,
  type EnvSource,
} from '@aegisvolt/config';
import { z } from 'zod';

export const SERVICE_NAME = 'saga-orchestrator-service';
export const DEFAULT_PORT = 4100;

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const serviceUrl = z.url({ protocol: /^https?$/ });

const serviceEnvSchema = z.object({
  /** `aegisvolt-sagas-<env>` (lo crea Terraform en cada ambiente). */
  DYNAMODB_TABLE_NAME: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
  DYNAMODB_CONNECTION_TIMEOUT_MS: int(50, 10_000, 1_000),
  DYNAMODB_REQUEST_TIMEOUT_MS: int(50, 10_000, 2_000),
  DYNAMODB_MAX_ATTEMPTS: int(1, 5, 2),
  STATION_RESERVATION_URL: serviceUrl,
  BILLING_WALLET_URL: serviceUrl,
  ENERGY_DISPATCH_URL: serviceUrl,
  /** Timeout de CADA llamada a un servicio participante. */
  SAGA_STEP_TIMEOUT_MS: int(100, 30_000, 3_000),
  /** Pasos de avance: intentos totales y backoff con jitter (solo errores transitorios). */
  SAGA_FORWARD_MAX_ATTEMPTS: int(1, 10, 3),
  SAGA_FORWARD_BASE_DELAY_MS: int(0, 10_000, 200),
  SAGA_FORWARD_MAX_DELAY_MS: int(0, 60_000, 2_000),
  /** Compensaciones: intentos inmediatos por ronda… */
  SAGA_COMPENSATION_ATTEMPTS: int(1, 10, 3),
  /** …y rondas automáticas con backoff largo (luego, solo reintento controlado). */
  SAGA_COMPENSATION_MAX_ROUNDS: int(1, 50, 10),
  SAGA_COMPENSATION_BASE_DELAY_MS: int(0, 3_600_000, 5_000),
  SAGA_COMPENSATION_MAX_DELAY_MS: int(0, 86_400_000, 900_000),
  /** *Lease* de ejecución de una SAGA (se renueva en cada escritura). */
  SAGA_LEASE_MS: int(1_000, 600_000, 30_000),
  /** Espera síncrona de `POST /v1/sagas`; si no terminó, responde 202 y sigue en segundo plano. */
  SAGA_SYNC_WAIT_MS: int(100, 120_000, 20_000),
  RECOVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  RECOVERY_INTERVAL_MS: int(500, 3_600_000, 10_000),
  RECOVERY_STALE_AFTER_MS: int(0, 3_600_000, 15_000),
  /** Antes del pivote, una SAGA retomada más tarde que esto se compensa (< hold de reserva). */
  SAGA_FORWARD_DEADLINE_MS: int(1_000, 3_600_000, 60_000),
  RECOVERY_BATCH_SIZE: int(1, 500, 25),
  HTTP_REQUEST_TIMEOUT_MS: int(100, 120_000, 30_000),
  SHUTDOWN_DRAIN_DELAY_MS: int(0, 60_000, 0),
  SHUTDOWN_GRACE_MS: int(100, 300_000, 40_000),
});

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ServiceConfig extends BaseConfig {
  readonly http: { readonly requestTimeoutMs: number };
  readonly dynamodb: {
    readonly tableName: string;
    readonly connectionTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maxAttempts: number;
  };
  readonly participants: {
    readonly stationReservationUrl: string;
    readonly billingWalletUrl: string;
    readonly energyDispatchUrl: string;
    readonly timeoutMs: number;
  };
  readonly saga: {
    readonly forward: RetryConfig;
    readonly compensationAttempts: RetryConfig;
    readonly compensationRounds: RetryConfig;
    readonly leaseMs: number;
    readonly syncWaitMs: number;
  };
  readonly recovery: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly staleAfterMs: number;
    readonly forwardDeadlineMs: number;
    readonly batchSize: number;
  };
  readonly shutdown: { readonly drainDelayMs: number; readonly graceMs: number };
}

export function loadServiceConfig(env: EnvSource): ServiceConfig {
  const base = loadBaseConfig(env, { serviceName: SERVICE_NAME, defaultPort: DEFAULT_PORT });
  const s = parseEnv(serviceEnvSchema, env);
  const errors: { variable: string; message: string }[] = [];

  if (base.appEnv === 'local' && base.aws.endpointUrl === undefined) {
    errors.push({
      variable: 'AWS_ENDPOINT_URL',
      message: 'obligatorio con APP_ENV=local (p. ej. Floci)',
    });
  }
  // El lease debe cubrir el tramo más largo sin escribir: dos llamadas (GET + PUT
  // de la reserva) con su timeout y la espera de backoff.
  const longestGap = 2 * s.SAGA_STEP_TIMEOUT_MS + s.SAGA_FORWARD_MAX_DELAY_MS;
  if (s.SAGA_LEASE_MS <= longestGap) {
    errors.push({
      variable: 'SAGA_LEASE_MS',
      message: `debe superar 2 × SAGA_STEP_TIMEOUT_MS + SAGA_FORWARD_MAX_DELAY_MS (${longestGap} ms)`,
    });
  }
  // Una SAGA con actividad reciente no se considera abandonada antes de que venza su lease.
  if (s.RECOVERY_STALE_AFTER_MS < longestGap) {
    errors.push({ variable: 'RECOVERY_STALE_AFTER_MS', message: `debe ser ≥ ${longestGap} ms` });
  }
  if (s.SAGA_FORWARD_BASE_DELAY_MS > s.SAGA_FORWARD_MAX_DELAY_MS) {
    errors.push({
      variable: 'SAGA_FORWARD_BASE_DELAY_MS',
      message: 'debe ser ≤ SAGA_FORWARD_MAX_DELAY_MS',
    });
  }
  if (s.SAGA_COMPENSATION_BASE_DELAY_MS > s.SAGA_COMPENSATION_MAX_DELAY_MS) {
    errors.push({
      variable: 'SAGA_COMPENSATION_BASE_DELAY_MS',
      message: 'debe ser ≤ SAGA_COMPENSATION_MAX_DELAY_MS',
    });
  }
  if (s.SHUTDOWN_GRACE_MS <= s.HTTP_REQUEST_TIMEOUT_MS) {
    errors.push({ variable: 'SHUTDOWN_GRACE_MS', message: 'debe superar HTTP_REQUEST_TIMEOUT_MS' });
  }
  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  return {
    ...base,
    http: { requestTimeoutMs: s.HTTP_REQUEST_TIMEOUT_MS },
    dynamodb: {
      tableName: s.DYNAMODB_TABLE_NAME,
      connectionTimeoutMs: s.DYNAMODB_CONNECTION_TIMEOUT_MS,
      requestTimeoutMs: s.DYNAMODB_REQUEST_TIMEOUT_MS,
      maxAttempts: s.DYNAMODB_MAX_ATTEMPTS,
    },
    participants: {
      stationReservationUrl: s.STATION_RESERVATION_URL,
      billingWalletUrl: s.BILLING_WALLET_URL,
      energyDispatchUrl: s.ENERGY_DISPATCH_URL,
      timeoutMs: s.SAGA_STEP_TIMEOUT_MS,
    },
    saga: {
      forward: {
        maxAttempts: s.SAGA_FORWARD_MAX_ATTEMPTS,
        baseDelayMs: s.SAGA_FORWARD_BASE_DELAY_MS,
        maxDelayMs: s.SAGA_FORWARD_MAX_DELAY_MS,
      },
      compensationAttempts: {
        maxAttempts: s.SAGA_COMPENSATION_ATTEMPTS,
        baseDelayMs: s.SAGA_FORWARD_BASE_DELAY_MS,
        maxDelayMs: s.SAGA_FORWARD_MAX_DELAY_MS,
      },
      compensationRounds: {
        maxAttempts: s.SAGA_COMPENSATION_MAX_ROUNDS,
        baseDelayMs: s.SAGA_COMPENSATION_BASE_DELAY_MS,
        maxDelayMs: s.SAGA_COMPENSATION_MAX_DELAY_MS,
      },
      leaseMs: s.SAGA_LEASE_MS,
      syncWaitMs: s.SAGA_SYNC_WAIT_MS,
    },
    recovery: {
      enabled: s.RECOVERY_ENABLED,
      intervalMs: s.RECOVERY_INTERVAL_MS,
      staleAfterMs: s.RECOVERY_STALE_AFTER_MS,
      forwardDeadlineMs: s.SAGA_FORWARD_DEADLINE_MS,
      batchSize: s.RECOVERY_BATCH_SIZE,
    },
    shutdown: { drainDelayMs: s.SHUTDOWN_DRAIN_DELAY_MS, graceMs: s.SHUTDOWN_GRACE_MS },
  };
}
