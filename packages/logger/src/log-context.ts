import { AsyncLocalStorage } from 'node:async_hooks';

/** Contexto de trazabilidad de una petición o de una SAGA (ADR-0009, ADR-0028). */
export interface LogContext {
  readonly correlationId: string;
  readonly sagaId?: string;
  /** Operación de negocio en curso (caso de uso, operación GraphQL o tarea). */
  readonly operation?: string;
}

/** El almacén es mutable solo para fijar `operation` una vez resuelta la ruta. */
type Store = { -readonly [K in keyof LogContext]: LogContext[K] };

const storage = new AsyncLocalStorage<Store>();

/**
 * Ejecuta `fn` con el contexto dado. Todo log emitido dentro de `fn` (también
 * tras `await`) incluye `correlation_id`, `operation` y, si existe, `saga_id`.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Fija la operación del contexto ACTUAL (p. ej. cuando el router ya resolvió la
 * ruta o Apollo identificó la operación GraphQL). Sin contexto no hace nada.
 */
export function setLogOperation(operation: string): void {
  const store = storage.getStore();
  if (store !== undefined) {
    store.operation = operation;
  }
}

/**
 * Middleware (compatible con Express, sin depender de él) que nombra la
 * operación de una ruta: `router.post(path, logOperation('CreateDebit'), handler)`.
 */
export function logOperation(operation: string) {
  return (_req: unknown, _res: unknown, next: () => void): void => {
    setLogOperation(operation);
    next();
  };
}
