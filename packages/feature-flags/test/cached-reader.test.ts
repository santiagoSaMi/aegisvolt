import { describe, expect, it, vi } from 'vitest';

import {
  CachedFeatureFlagReader,
  type FeatureFlagKey,
  type FeatureFlagSource,
  type FeatureFlagState,
} from '../src/index.ts';

const KEY: FeatureFlagKey = 'SIMULATE_CHARGER_HARDWARE_FAULT';

const state = (enabled: boolean, version = 1): FeatureFlagState => ({
  key: KEY,
  enabled,
  version,
  updatedAt: '2026-11-13T12:00:00.000Z',
  updatedBy: 'admin',
});

/** Almacén controlable: devuelve lo que se le indique y cuenta las lecturas. */
function controllableSource(initial: FeatureFlagState | undefined | Error) {
  let next: FeatureFlagState | undefined | Error = initial;
  const fetch = vi.fn((): Promise<FeatureFlagState | undefined> =>
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next),
  );
  const source: FeatureFlagSource = { fetch };
  return {
    source,
    fetch,
    set: (value: FeatureFlagState | undefined | Error) => {
      next = value;
    },
  };
}

describe('CachedFeatureFlagReader', () => {
  it('lee el valor del almacén y lo sirve desde la caché mientras está vigente', async () => {
    let now = 0;
    const store = controllableSource(state(true));
    const reader = new CachedFeatureFlagReader(store.source, { ttlMs: 5_000, now: () => now });

    expect(await reader.isEnabled(KEY)).toBe(true);
    store.set(state(false, 2));
    now = 4_999;
    expect(await reader.isEnabled(KEY)).toBe(true);
    expect(store.fetch).toHaveBeenCalledTimes(1);
  });

  it('refleja un cambio al vencer el TTL, sin reiniciar el proceso', async () => {
    let now = 0;
    const store = controllableSource(state(false));
    const reader = new CachedFeatureFlagReader(store.source, { ttlMs: 5_000, now: () => now });

    expect(await reader.isEnabled(KEY)).toBe(false);
    store.set(state(true, 2));
    now = 5_000;
    expect(await reader.isEnabled(KEY)).toBe(true);
  });

  it('una flag inexistente vale false', async () => {
    const reader = new CachedFeatureFlagReader(controllableSource(undefined).source);

    expect(await reader.isEnabled(KEY)).toBe(false);
  });

  it('si el almacén falla usa el último valor conocido y avisa', async () => {
    let now = 0;
    const store = controllableSource(state(true));
    const onError = vi.fn();
    const reader = new CachedFeatureFlagReader(store.source, {
      ttlMs: 1_000,
      now: () => now,
      onError,
    });
    await reader.isEnabled(KEY);

    store.set(new Error('DynamoDB caído'));
    now = 1_000;
    expect(await reader.isEnabled(KEY)).toBe(true);
    expect(onError).toHaveBeenCalledWith(KEY, expect.any(Error), true);
  });

  it('sin valor conocido, un fallo del almacén da el valor seguro false', async () => {
    const reader = new CachedFeatureFlagReader(controllableSource(new Error('timeout')).source);

    expect(await reader.isEnabled(KEY)).toBe(false);
  });

  it('tras un fallo no reintenta hasta que vence el TTL', async () => {
    let now = 0;
    const store = controllableSource(new Error('timeout'));
    const reader = new CachedFeatureFlagReader(store.source, { ttlMs: 1_000, now: () => now });

    await reader.isEnabled(KEY);
    now = 500;
    await reader.isEnabled(KEY);
    expect(store.fetch).toHaveBeenCalledTimes(1);
  });

  it('las evaluaciones simultáneas comparten una sola lectura', async () => {
    const store = controllableSource(state(true));
    const reader = new CachedFeatureFlagReader(store.source);

    const values = await Promise.all(Array.from({ length: 10 }, () => reader.isEnabled(KEY)));
    expect(values.every(Boolean)).toBe(true);
    expect(store.fetch).toHaveBeenCalledTimes(1);
  });

  it('con TTL 0 cada evaluación lee el almacén', async () => {
    const store = controllableSource(state(false));
    const reader = new CachedFeatureFlagReader(store.source, { ttlMs: 0 });

    await reader.isEnabled(KEY);
    store.set(state(true, 2));
    expect(await reader.isEnabled(KEY)).toBe(true);
    expect(store.fetch).toHaveBeenCalledTimes(2);
  });
});
