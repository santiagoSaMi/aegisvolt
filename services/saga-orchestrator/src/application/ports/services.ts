import type { RetryPolicy, SagaEvent, SagaTransaction } from '../../domain/index.ts';

export interface Clock {
  now(): Date;
}

/** Generador de UUID (claves idempotentes de confirmación y compensaciones). */
export interface IdGenerator {
  uuid(): string;
}

/** Espera entre reintentos (inyectable: las pruebas no esperan de verdad). */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Observador de transiciones persistidas: la infraestructura las registra en
 * logs JSON con `correlation_id` y `saga_id` (CloudWatch, ADR-0014).
 */
export interface SagaObserver {
  transitioned(saga: SagaTransaction, events: readonly SagaEvent[]): void;
}

export interface SagaExecutionPolicy {
  /** Reintentos de un paso de avance (intentos totales y backoff). */
  readonly forward: RetryPolicy;
  /** Intentos inmediatos de una compensación dentro de una ronda. */
  readonly compensationAttempts: RetryPolicy;
  /** Rondas de compensación automáticas (backoff largo, worker de recuperación). */
  readonly compensationRounds: RetryPolicy;
  /** Duración del *lease* de ejecución; debe superar el tiempo de un paso con sus reintentos. */
  readonly leaseMs: number;
}
