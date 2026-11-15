/** Forma estable de un error en los logs (campo `error`). */
export interface LoggedError {
  /** Clase o tipo del error (p. ej. `InsufficientFundsError`, `TimeoutError`). */
  readonly type: string;
  /** Código estable del catálogo (dominio, aplicación, AWS SDK o red), si existe. */
  readonly code?: string;
  readonly message: string;
  /** Solo para errores no tipados (inesperados): ayudan a depurar. */
  readonly stack?: string;
  readonly cause?: LoggedError;
}

const MAX_MESSAGE = 500;
const MAX_CAUSE_DEPTH = 3;

/**
 * Normaliza cualquier valor lanzado a un `LoggedError`. Los errores con `code`
 * (dominio, aplicación) son esperados: se registran sin stack. Los demás
 * conservan el stack (solo en logs; nunca en respuestas).
 */
export function toLoggedError(value: unknown, depth = 0): LoggedError {
  if (value instanceof Error) {
    const code = codeOf(value);
    const type = value.name !== 'Error' ? value.name : value.constructor.name;
    return {
      type,
      ...(code === undefined ? {} : { code }),
      message: truncate(value.message),
      ...(code === undefined && value.stack !== undefined ? { stack: value.stack } : {}),
      ...(value.cause !== undefined && depth < MAX_CAUSE_DEPTH
        ? { cause: toLoggedError(value.cause, depth + 1) }
        : {}),
    };
  }
  if (isLoggedError(value)) {
    return value;
  }
  return {
    type: 'NonError',
    message: truncate(typeof value === 'string' ? value : safeString(value)),
  };
}

function codeOf(error: Error): string | undefined {
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && code !== '' ? code : undefined;
}

function isLoggedError(value: unknown): value is LoggedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function safeString(value: unknown): string {
  // JSON.stringify no representa estos valores (devolvería undefined).
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // Referencias circulares o BigInt.
    return Object.prototype.toString.call(value);
  }
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
}
