import {
  ConcurrentModificationError,
  DependencyUnavailableError,
} from '../../application/index.ts';

const UNAVAILABLE_ERROR_NAMES = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
]);

interface AwsLikeError {
  name?: unknown;
  code?: unknown;
  CancellationReasons?: { Code?: string }[];
}

/**
 * Traduce errores del AWS SDK a errores de aplicación:
 * - Condición fallida (también dentro de una transacción) o conflicto de
 *   transacción → `ConcurrentModificationError` (el caso de uso relee y reintenta).
 * - Timeouts, throttling o red → `DependencyUnavailableError` (503).
 * Cualquier otro error se propaga sin cambios (500).
 */
export function translateDynamoDbError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return error;
  }
  const { name, code, CancellationReasons } = error as AwsLikeError;

  if (name === 'ConditionalCheckFailedException' || name === 'TransactionConflictException') {
    return new ConcurrentModificationError('Escritura condicional rechazada', { cause: error });
  }
  if (name === 'TransactionCanceledException') {
    const codes = (CancellationReasons ?? []).map((reason) => reason.Code);
    if (codes.includes('ConditionalCheckFailed') || codes.includes('TransactionConflict')) {
      return new ConcurrentModificationError('Transacción condicional rechazada', { cause: error });
    }
    return new DependencyUnavailableError('Transacción DynamoDB cancelada', { cause: error });
  }
  if (
    (typeof name === 'string' && UNAVAILABLE_ERROR_NAMES.has(name)) ||
    (typeof code === 'string' && NETWORK_ERROR_CODES.has(code))
  ) {
    return new DependencyUnavailableError('DynamoDB no disponible', { cause: error });
  }
  return error;
}

/** Ejecuta una llamada a DynamoDB traduciendo sus errores. */
export async function dynamo<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw translateDynamoDbError(error);
  }
}
