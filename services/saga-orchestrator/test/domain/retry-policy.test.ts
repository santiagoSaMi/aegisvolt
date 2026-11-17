import { describe, expect, it } from 'vitest';

import { InvalidValueError, RetryPolicy, isTransientFailure } from '../../src/domain/index.ts';

describe('RetryPolicy', () => {
  const policy = new RetryPolicy({
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 1_000,
    multiplier: 2,
  });

  it('permite reintentar mientras no se alcance maxAttempts', () => {
    expect([0, 1, 2, 3].map((failed) => policy.canRetry(failed))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('backoff exponencial con equal jitter y tope', () => {
    // Exponencial: 200, 400, 800, 1000 (tope). Con random=0 → mitad; con random=1 → total.
    expect([1, 2, 3, 4].map((n) => policy.delayAfter(n, () => 0))).toEqual([100, 200, 400, 500]);
    expect([1, 2, 3, 4].map((n) => policy.delayAfter(n, () => 1))).toEqual([200, 400, 800, 1_000]);
  });

  it('acota valores aleatorios fuera de [0, 1]', () => {
    expect(policy.delayAfter(1, () => 5)).toBe(200);
    expect(policy.delayAfter(1, () => -5)).toBe(100);
  });

  it('valida su configuración y sus argumentos', () => {
    expect(
      () => new RetryPolicy({ maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1, multiplier: 2 }),
    ).toThrow(InvalidValueError);
    expect(
      () => new RetryPolicy({ maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 5, multiplier: 2 }),
    ).toThrow(InvalidValueError);
    expect(() => policy.delayAfter(0, () => 0)).toThrow(InvalidValueError);
  });

  it('las políticas por defecto siguen el diseño (ADR-0004, 02-saga.md)', () => {
    expect(RetryPolicy.FORWARD.config.maxAttempts).toBe(3);
    expect(RetryPolicy.COMPENSATION.config).toMatchObject({ maxAttempts: 10, maxDelayMs: 900_000 });
  });
});

describe('isTransientFailure', () => {
  it('solo reintenta errores transitorios, nunca rechazos de negocio', () => {
    expect(isTransientFailure('TIMEOUT')).toBe(true);
    expect(isTransientFailure('THROTTLED')).toBe(true);
    expect(isTransientFailure('BUSINESS_REJECTION')).toBe(false);
    expect(isTransientFailure('CLIENT_ERROR')).toBe(false);
  });
});
