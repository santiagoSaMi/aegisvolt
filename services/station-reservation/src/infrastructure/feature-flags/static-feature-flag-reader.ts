import type { FeatureFlagReader, StationReservationFlag } from '../../application/index.ts';

/**
 * Adaptador PROVISIONAL de flags: valores fijados por configuración.
 *
 * El adaptador definitivo leerá `aegisvolt-feature-flags-<env>` con caché corta
 * (ADR-0007, paquete `packages/feature-flags`) para cambiar flags sin redesplegar.
 * Como implementa el mismo puerto, la sustitución no toca la aplicación.
 */
export class StaticFeatureFlagReader implements FeatureFlagReader {
  private readonly values: Readonly<Record<StationReservationFlag, boolean>>;

  constructor(values: Readonly<Record<StationReservationFlag, boolean>>) {
    this.values = values;
  }

  isEnabled(flag: StationReservationFlag): Promise<boolean> {
    return Promise.resolve(this.values[flag]);
  }
}
