import type { FeatureFlagKey, FeatureFlagReader, FeatureFlagSource } from './reader.ts';

/** TTL por defecto de la caché (ADR-0007): un cambio se refleja en ≤ 5 s. */
export const DEFAULT_FLAG_CACHE_TTL_MS = 5_000;

export interface CachedFeatureFlagReaderOptions {
  /** Vigencia de cada valor en memoria. `0` desactiva la caché (cada evaluación lee). */
  readonly ttlMs?: number;
  /** Reloj en ms (inyectable en pruebas). */
  readonly now?: () => number;
  /** Se invoca cuando el almacén falla; el lector sigue respondiendo. */
  readonly onError?: (key: FeatureFlagKey, error: unknown, fallback: boolean) => void;
}

interface CacheEntry {
  readonly enabled: boolean;
  readonly fetchedAt: number;
}

/**
 * Lector con caché en memoria por réplica (ADR-0007):
 * - un valor vigente se sirve sin leer el almacén;
 * - las lecturas simultáneas de una misma flag comparten una sola consulta;
 * - una flag inexistente vale `false`;
 * - si el almacén falla, usa el último valor conocido o, si no lo hay, el valor
 *   seguro `false`, y no vuelve a intentarlo hasta que venza el TTL (evita
 *   martillear una dependencia caída).
 */
export class CachedFeatureFlagReader implements FeatureFlagReader {
  private readonly source: FeatureFlagSource;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onError: CachedFeatureFlagReaderOptions['onError'];
  private readonly cache = new Map<FeatureFlagKey, CacheEntry>();
  private readonly inFlight = new Map<FeatureFlagKey, Promise<boolean>>();

  constructor(source: FeatureFlagSource, options: CachedFeatureFlagReaderOptions = {}) {
    this.source = source;
    this.ttlMs = options.ttlMs ?? DEFAULT_FLAG_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  isEnabled(key: FeatureFlagKey): Promise<boolean> {
    const cached = this.cache.get(key);
    if (cached !== undefined && this.now() - cached.fetchedAt < this.ttlMs) {
      return Promise.resolve(cached.enabled);
    }
    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const load = this.load(key, cached).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, load);
    return load;
  }

  private async load(key: FeatureFlagKey, previous: CacheEntry | undefined): Promise<boolean> {
    let enabled: boolean;
    try {
      const state = await this.source.fetch(key);
      enabled = state?.enabled ?? false;
    } catch (error) {
      enabled = previous?.enabled ?? false;
      this.onError?.(key, error, enabled);
    }
    this.cache.set(key, { enabled, fetchedAt: this.now() });
    return enabled;
  }
}
