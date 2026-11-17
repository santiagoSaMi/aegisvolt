import { z } from 'zod';

import { ConfigValidationError } from './errors.ts';

export const APP_ENVIRONMENTS = ['local', 'dev', 'test', 'prod'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Variables comunes a todas las apps y servicios Node.js. */
export const baseEnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS),
  SERVICE_VERSION: z.string().min(1).default('local'),
  PORT: z.coerce.number().int().min(0).max(65_535).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
});
export type BaseEnv = z.output<typeof baseEnvSchema>;

/**
 * Valida `env` contra `schema`. Lanza `ConfigValidationError` con todas las
 * variables inválidas a la vez (fail fast al arrancar).
 */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  env: EnvSource,
): z.output<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => ({
        variable: issue.path.map(String).join('.') || '(raíz)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export interface BaseConfig {
  readonly serviceName: string;
  readonly appEnv: AppEnvironment;
  readonly serviceVersion: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly aws: {
    readonly region: string;
    /** Solo en entornos locales (Floci). En AWS real se usan los endpoints por defecto. */
    readonly endpointUrl?: string;
  };
}

export interface BaseConfigOptions {
  /** Nombre fijo del servicio: lo define el código, no el entorno. */
  readonly serviceName: string;
  /** Puerto por defecto si `PORT` no está definido. */
  readonly defaultPort: number;
}

export function loadBaseConfig(env: EnvSource, options: BaseConfigOptions): BaseConfig {
  const parsed = parseEnv(baseEnvSchema, env);
  return {
    serviceName: options.serviceName,
    appEnv: parsed.APP_ENV,
    serviceVersion: parsed.SERVICE_VERSION,
    port: parsed.PORT ?? options.defaultPort,
    logLevel: parsed.LOG_LEVEL,
    aws: {
      region: parsed.AWS_REGION,
      ...(parsed.AWS_ENDPOINT_URL === undefined ? {} : { endpointUrl: parsed.AWS_ENDPOINT_URL }),
    },
  };
}
