import type { FeatureFlagReader, StationReservationFlag } from '../../src/application/index.ts';

/**
 * Doble de prueba: flags con valores fijos (sin DynamoDB). En ejecución el
 * servicio usa el lector de `aegisvolt-feature-flags-<env>` (ADR-0025).
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
