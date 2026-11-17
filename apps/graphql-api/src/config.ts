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
const serviceUrl = z.url({ protocol: /^https?$/ });

/** Variables del módulo de flags (también las usa la CLI local de operador). */
const flagsEnvSchema = z.object({
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

/** Variables del servidor GraphQL (BFF). */
const serverEnvSchema = z.object({
  /** Servicios internos (en Kubernetes, nombres de Service; nunca sus tablas). */
  STATION_RESERVATION_URL: serviceUrl,
  BILLING_WALLET_URL: serviceUrl,
  ENERGY_DISPATCH_URL: serviceUrl,
  SAGA_ORCHESTRATOR_URL: serviceUrl,
  /** Timeout por intento de cada llamada interna. */
  UPSTREAM_TIMEOUT_MS: ms(100, 30_000, 3_000),
  /** Reintentos adicionales, solo para operaciones idempotentes y fallos transitorios. */
  UPSTREAM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  /** Timeout de iniciar la SAGA: mayor que la espera síncrona del orquestador (20 s). */
  SAGA_START_TIMEOUT_MS: ms(1_000, 120_000, 25_000),
  /** Cognito del ambiente (ADR-0008): `iss` esperado, app client (`aud`) y JWKS. */
  COGNITO_ISSUER: z.url(),
  COGNITO_CLIENT_ID: z.string().min(1).max(128),
  /** Por defecto `<COGNITO_ISSUER>/.well-known/jwks.json`; en Floci, el host accesible. */
  COGNITO_JWKS_URL: z.url().optional(),
  /** Por defecto: habilitada salvo en prod. */
  GRAPHQL_INTROSPECTION: z.enum(['true', 'false']).optional(),
  GRAPHQL_MAX_DEPTH: z.coerce.number().int().min(2).max(20).default(8),
  SHUTDOWN_DRAIN_DELAY_MS: ms(0, 60_000, 0),
  SHUTDOWN_GRACE_MS: ms(100, 300_000, 35_000),
});

export interface FlagsConfig extends BaseConfig {
  readonly featureFlags: { readonly tableName: string; readonly cacheTtlMs: number };
  readonly dynamodb: {
    readonly connectionTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maxAttempts: number;
  };
}

export interface ServiceConfig extends FlagsConfig {
  readonly upstreams: {
    readonly stationReservationUrl: string;
    readonly billingWalletUrl: string;
    readonly energyDispatchUrl: string;
    readonly sagaOrchestratorUrl: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly sagaStartTimeoutMs: number;
  };
  readonly cognito: {
    readonly issuer: string;
    readonly clientId: string;
    readonly jwksUrl: string;
  };
  readonly graphql: { readonly introspection: boolean; readonly maxDepth: number };
  readonly shutdown: { readonly drainDelayMs: number; readonly graceMs: number };
}

/**
 * Configuración del módulo de flags. El ambiente (`APP_ENV`) lo inyecta el
 * despliegue y determina la tabla: ningún cliente puede elegir otro ambiente.
 */
export function loadFlagsConfig(env: EnvSource): FlagsConfig {
  const base = loadBaseConfig(env, { serviceName: SERVICE_NAME, defaultPort: DEFAULT_PORT });
  const flags = parseEnv(flagsEnvSchema, env);
  if (base.appEnv === 'local' && base.aws.endpointUrl === undefined) {
    throw new ConfigValidationError([
      { variable: 'AWS_ENDPOINT_URL', message: 'obligatorio con APP_ENV=local (p. ej. Floci)' },
    ]);
  }
  let tableName: string;
  try {
    tableName = resolveFeatureFlagsTable(base.appEnv, flags.FEATURE_FLAGS_TABLE_NAME);
  } catch (error) {
    throw new ConfigValidationError([
      { variable: 'FEATURE_FLAGS_TABLE_NAME', message: (error as Error).message },
    ]);
  }
  return {
    ...base,
    featureFlags: { tableName, cacheTtlMs: flags.FEATURE_FLAGS_CACHE_TTL_MS },
    dynamodb: {
      connectionTimeoutMs: flags.DYNAMODB_CONNECTION_TIMEOUT_MS,
      requestTimeoutMs: flags.DYNAMODB_REQUEST_TIMEOUT_MS,
      maxAttempts: flags.DYNAMODB_MAX_ATTEMPTS,
    },
  };
}

/** Configuración completa del servidor GraphQL. */
export function loadServiceConfig(env: EnvSource): ServiceConfig {
  const flags = loadFlagsConfig(env);
  const server = parseEnv(serverEnvSchema, env);
  if (server.SHUTDOWN_GRACE_MS <= server.SAGA_START_TIMEOUT_MS) {
    throw new ConfigValidationError([
      { variable: 'SHUTDOWN_GRACE_MS', message: 'debe superar SAGA_START_TIMEOUT_MS' },
    ]);
  }
  const issuer = server.COGNITO_ISSUER.replace(/\/$/, '');
  return {
    ...flags,
    upstreams: {
      stationReservationUrl: server.STATION_RESERVATION_URL,
      billingWalletUrl: server.BILLING_WALLET_URL,
      energyDispatchUrl: server.ENERGY_DISPATCH_URL,
      sagaOrchestratorUrl: server.SAGA_ORCHESTRATOR_URL,
      timeoutMs: server.UPSTREAM_TIMEOUT_MS,
      maxRetries: server.UPSTREAM_MAX_RETRIES,
      sagaStartTimeoutMs: server.SAGA_START_TIMEOUT_MS,
    },
    cognito: {
      issuer,
      clientId: server.COGNITO_CLIENT_ID,
      jwksUrl: server.COGNITO_JWKS_URL ?? `${issuer}/.well-known/jwks.json`,
    },
    graphql: {
      introspection:
        server.GRAPHQL_INTROSPECTION === undefined
          ? flags.appEnv !== 'prod'
          : server.GRAPHQL_INTROSPECTION === 'true',
      maxDepth: server.GRAPHQL_MAX_DEPTH,
    },
    shutdown: { drainDelayMs: server.SHUTDOWN_DRAIN_DELAY_MS, graceMs: server.SHUTDOWN_GRACE_MS },
  };
}
