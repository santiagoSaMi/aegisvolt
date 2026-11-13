import { ConcurrentModificationError } from './errors.ts';

/** Intentos máximos ante conflictos de concurrencia antes de rendirse. */
export const MAX_OPTIMISTIC_ATTEMPTS = 3;

/**
 * Ejecuta `operation` (leer → decidir con el dominio → escritura condicional) y,
 * si otra petición escribió entre medias (`ConcurrentModificationError`), la
 * repite releyendo el estado. En el reintento el dominio decide con datos frescos:
 * p. ej. dos administradores cambiando la misma flag a la vez.
 */
export async function withOptimisticRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = MAX_OPTIMISTIC_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ConcurrentModificationError) || attempt >= maxAttempts) {
        throw error;
      }
    }
  }
}
