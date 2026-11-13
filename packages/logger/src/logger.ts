import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';

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

/** Rutas cuyo valor nunca debe llegar a los logs. */
const REDACTED_PATHS = [
  'password',
  'token',
  'accessToken',
  'idToken',
  'refreshToken',
  'secret',
  'secretAccessKey',
  'authorization',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.secretAccessKey',
  '*.authorization',
];

/**
 * Crea un logger JSON (una línea por evento) con los campos obligatorios de
 * CLAUDE.md: timestamp, level, service, environment, correlation_id y message.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const instance = pino(
    {
      level: options.level ?? 'info',
      messageKey: 'message',
      base: {
        service: options.service,
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
        };
      },
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
