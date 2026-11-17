import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';

import { toLoggedError } from './error.ts';
import { getLogContext } from './log-context.ts';

export type LoggerLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Puerto de logging que usan las apps. No expone tipos de pino para que el
 * resto del código no dependa de la librería concreta (Dependency Inversion).
 */
export interface Logger {
  fatal(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
  /** Logger hijo con campos fijos adicionales (p. ej. `component`). */
  child(fields: LogFields): Logger;
}

/** Cualquier destino con `write(line)`; por defecto stdout. */
export type LogDestination = DestinationStream;

export interface CreateLoggerOptions {
  readonly service: string;
  readonly environment: string;
  readonly version: string;
  readonly level?: LoggerLevel;
  readonly destination?: LogDestination;
}

/**
 * Claves cuyo valor nunca debe llegar a los logs: secretos, credenciales,
 * tokens y datos personales que la plataforma no necesita registrar (ADR-0028).
 * Se ocultan en el primer y segundo nivel de los campos.
 */
const SENSITIVE_KEYS = [
  'password',
  'token',
  'accessToken',
  'idToken',
  'refreshToken',
  'secret',
  'clientSecret',
  'secretAccessKey',
  'accessKeyId',
  'sessionToken',
  'credentials',
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apiKey',
  'AuthParameters',
  'email',
  'phone',
  'phoneNumber',
];

const REDACTED_PATHS = SENSITIVE_KEYS.flatMap((key) => {
  const path = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const nested = path.startsWith('[') ? `*${path}` : `*.${path}`;
  return [path, nested];
});

/**
 * Crea un logger JSON (una línea por evento) con los campos de ADR-0028:
 * `timestamp`, `level`, `environment`, `service_name`, `correlation_id`,
 * `saga_id` (cuando aplica), `operation`, `message` y `error` tipado.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const instance = pino(
    {
      level: options.level ?? 'info',
      messageKey: 'message',
      base: {
        service_name: options.service,
        environment: options.environment,
        version: options.version,
      },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
      },
      mixin: () => {
        const context = getLogContext();
        return {
          correlation_id: context?.correlationId ?? null,
          ...(context?.sagaId === undefined ? {} : { saga_id: context.sagaId }),
          operation: context?.operation ?? null,
        };
      },
      // Cualquier campo `error` (Error, string u objeto) se registra con forma estable.
      serializers: { error: toLoggedError },
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    },
    options.destination ?? pino.destination({ dest: 1, sync: false }),
  );
  return wrap(instance);
}

function wrap(instance: PinoLogger): Logger {
  const emit =
    (level: LoggerLevel) =>
    (message: string, fields?: LogFields): void => {
      if (fields === undefined) {
        instance[level](message);
      } else {
        instance[level](fields, message);
      }
    };

  return {
    fatal: emit('fatal'),
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    trace: emit('trace'),
    child: (fields) => wrap(instance.child(fields)),
  };
}
