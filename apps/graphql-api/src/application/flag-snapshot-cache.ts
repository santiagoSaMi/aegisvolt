import type { FeatureFlag } from '../domain/index.ts';
import type { Clock } from './ports/feature-flags.ts';

/**
 * Caché de la lectura de flags del graphql-api:
 * - TTL corto (por defecto 5 s, ADR-0007): un cambio hecho en otra réplica se
 *   ve como mucho al vencer el TTL;
 * - `invalidate()`: la réplica que ESCRIBE descarta su caché al confirmar el
 *   cambio, así que su siguiente lectura ya lo refleja;
 * - `lastKnown`: último valor leído con éxito, para responder (marcado como
 *   degradado) si la tabla no está disponible.
 */
export class FlagSnapshotCache {
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private snapshot: { flags: readonly FeatureFlag[]; at: number } | undefined;
  private lastKnown: readonly FeatureFlag[] | undefined;

  constructor(deps: { ttlMs: number; clock: Clock }) {
    this.ttlMs = deps.ttlMs;
    this.clock = deps.clock;
  }

  fresh(): readonly FeatureFlag[] | undefined {
    if (this.snapshot === undefined) {
      return undefined;
    }
    return this.clock.now().getTime() - this.snapshot.at < this.ttlMs
      ? this.snapshot.flags
      : undefined;
  }

  store(flags: readonly FeatureFlag[]): void {
    this.snapshot = { flags, at: this.clock.now().getTime() };
    this.lastKnown = flags;
  }

  stale(): readonly FeatureFlag[] | undefined {
    return this.lastKnown;
  }

  invalidate(): void {
    this.snapshot = undefined;
  }
}
