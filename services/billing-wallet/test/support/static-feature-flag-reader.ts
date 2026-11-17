import type { BillingFlag, FeatureFlagReader } from '../../src/application/index.ts';

/**
 * Doble de prueba: flags con valores fijos (sin DynamoDB). En ejecución el
 * servicio usa el lector de `aegisvolt-feature-flags-<env>` (ADR-0025).
 */
export class StaticFeatureFlagReader implements FeatureFlagReader {
  private readonly values: Readonly<Record<BillingFlag, boolean>>;

  constructor(values: Readonly<Record<BillingFlag, boolean>>) {
    this.values = values;
  }

  isEnabled(flag: BillingFlag): Promise<boolean> {
    return Promise.resolve(this.values[flag]);
  }
}
