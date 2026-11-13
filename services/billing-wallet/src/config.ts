import {
  ConfigValidationError,
  loadBaseConfig,
  parseEnv,
  type BaseConfig,
  type EnvSource,
} from '@aegisvolt/config';
import { z } from 'zod';

export const SERVICE_NAME = 'billing-wallet-service';
export const DEFAULT_PORT = 4102;

const ms = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const minorPerKwh = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** `HH:MM-HH:MM` separados por comas (hora local), p. ej. `17:00-21:00`. */
const peakWindowsSchema = z
  .string()
  .default('17:00-21:00')
  .transform((value, ctx) => {
    const windows: { startMinute: number; endMinute: number }[] = [];
    for (const part of value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)) {
      const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(part);
      if (match === null) {
        ctx.addIssue({ code: 'custom', message: `ventana inválida: ${part}` });
        return z.NEVER;
      }
      const [, h1, m1, h2, m2] = match.map(Number);
      windows.push({
        startMinute: (h1 ?? 0) * 60 + (m1 ?? 0),
        endMinute: (h2 ?? 0) * 60 + (m2 ?? 0),
      });
    }
    return windows;
  });

const serviceEnvSchema = z.object({
  /** `aegisvolt-billing-<env>` (lo crea Terraform en cada ambiente). */
  DYNAMODB_TABLE_NAME: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
  HTTP_REQUEST_TIMEOUT_MS: ms(100, 30_000, 5_000),
  DYNAMODB_CONNECTION_TIMEOUT_MS: ms(50, 10_000, 1_000),
  DYNAMODB_REQUEST_TIMEOUT_MS: ms(50, 10_000, 2_000),
  DYNAMODB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  /** Moneda de las billeteras (ISO 4217); los importes se manejan en unidades menores enteras. */
  WALLET_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('COP'),
  PRICING_TARIFF_STANDARD_MINOR_PER_KWH: minorPerKwh(80_000),
  PRICING_TARIFF_FAST_MINOR_PER_KWH: minorPerKwh(100_000),
  PRICING_TARIFF_ULTRA_FAST_MINOR_PER_KWH: minorPerKwh(140_000),
  PRICING_SURGE_MULTIPLIER_BP: z.coerce.number().int().min(10_000).max(100_000).default(12_500),
  PRICING_PEAK_WINDOWS: peakWindowsSchema,
  /** Desfase local respecto de UTC en minutos (Bogotá: -300, sin horario de verano). */
  PRICING_UTC_OFFSET_MINUTES: z.coerce.number().int().min(-840).max(840).default(-300),
  /** Provisional hasta el lector de flags en DynamoDB (ADR-0007). */
  FEATURE_ENABLE_DYNAMIC_SURGE_PRICING: z
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
  readonly pricing: {
    readonly currency: string;
    readonly tariffMinorPerKwh: { STANDARD: number; FAST: number; ULTRA_FAST: number };
    readonly surgeMultiplierBasisPoints: number;
    readonly peakWindows: readonly { startMinute: number; endMinute: number }[];
    readonly utcOffsetMinutes: number;
  };
  readonly featureFlags: { readonly ENABLE_DYNAMIC_SURGE_PRICING: boolean };
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
    pricing: {
      currency: service.WALLET_CURRENCY,
      tariffMinorPerKwh: {
        STANDARD: service.PRICING_TARIFF_STANDARD_MINOR_PER_KWH,
        FAST: service.PRICING_TARIFF_FAST_MINOR_PER_KWH,
        ULTRA_FAST: service.PRICING_TARIFF_ULTRA_FAST_MINOR_PER_KWH,
      },
      surgeMultiplierBasisPoints: service.PRICING_SURGE_MULTIPLIER_BP,
      peakWindows: service.PRICING_PEAK_WINDOWS,
      utcOffsetMinutes: service.PRICING_UTC_OFFSET_MINUTES,
    },
    featureFlags: { ENABLE_DYNAMIC_SURGE_PRICING: service.FEATURE_ENABLE_DYNAMIC_SURGE_PRICING },
  };
}
