import { InvalidValueError } from '../shared/domain-error.ts';

/**
 * Clasificación del resultado fallido de una llamada a otro servicio. Solo los
 * transitorios se reintentan; un rechazo de negocio (403/404/409/422) es definitivo.
 */
export const FAILURE_KINDS = [
  'NETWORK_ERROR',
  'TIMEOUT',
  'SERVER_ERROR',
  'THROTTLED',
  'BUSINESS_REJECTION',
  'CLIENT_ERROR',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export function isTransientFailure(kind: FailureKind): boolean {
  return (
    kind === 'NETWORK_ERROR' ||
    kind === 'TIMEOUT' ||
    kind === 'SERVER_ERROR' ||
    kind === 'THROTTLED'
  );
}

export interface RetryPolicyConfig {
  /** Intentos fallidos permitidos antes de rendirse. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
}

/**
 * Backoff exponencial con *equal jitter*: espera entre la mitad y el total del
 * retardo exponencial, acotado por `maxDelayMs`. El aleatorio se inyecta para
 * que las pruebas sean deterministas.
 */
export class RetryPolicy {
  /** Pasos de avance: 3 intentos, 200 ms → 2 s (ADR-0004). */
  static readonly FORWARD = new RetryPolicy({
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 2_000,
    multiplier: 2,
  });

  /** Compensaciones (RecoveryWorker): 10 rondas, 5 s → 15 min (02-saga.md §8). */
  static readonly COMPENSATION = new RetryPolicy({
    maxAttempts: 10,
    baseDelayMs: 5_000,
    maxDelayMs: 900_000,
    multiplier: 3,
  });

  readonly config: RetryPolicyConfig;

  constructor(config: RetryPolicyConfig) {
    const { maxAttempts, baseDelayMs, maxDelayMs, multiplier } = config;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvalidValueError('maxAttempts', 'debe ser un entero ≥ 1');
    }
    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
      throw new InvalidValueError('baseDelayMs', 'debe ser un entero ≥ 0');
    }
    if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
      throw new InvalidValueError('maxDelayMs', 'debe ser un entero ≥ baseDelayMs');
    }
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      throw new InvalidValueError('multiplier', 'debe ser ≥ 1');
    }
    this.config = config;
  }

  /** ¿Se puede intentar de nuevo tras `failedAttempts` fallos? */
  canRetry(failedAttempts: number): boolean {
    return failedAttempts < this.config.maxAttempts;
  }

  /** Espera antes del siguiente intento tras `failedAttempts` fallos (≥ 1). */
  delayAfter(failedAttempts: number, random: () => number): number {
    if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
      throw new InvalidValueError('failedAttempts', 'debe ser un entero ≥ 1');
    }
    const exponential = Math.min(
      this.config.maxDelayMs,
      this.config.baseDelayMs * this.config.multiplier ** (failedAttempts - 1),
    );
    const sample = Math.min(Math.max(random(), 0), 1);
    return Math.floor(exponential / 2 + (sample * exponential) / 2);
  }
}
