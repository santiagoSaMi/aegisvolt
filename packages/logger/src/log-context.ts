import { AsyncLocalStorage } from 'node:async_hooks';

/** Contexto de trazabilidad de una petición o de una SAGA (ADR-0009). */
export interface LogContext {
  readonly correlationId: string;
  readonly sagaId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Ejecuta `fn` con el contexto dado. Todo log emitido dentro de `fn` (también
 * tras `await`) incluye `correlation_id` y, si existe, `saga_id`.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}
