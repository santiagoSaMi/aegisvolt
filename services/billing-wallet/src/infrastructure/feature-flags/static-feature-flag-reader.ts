import type { BillingFlag, FeatureFlagReader } from '../../application/index.ts';

/**
 * Adaptador PROVISIONAL de flags: valores fijados por configuración. El
 * definitivo leerá `aegisvolt-feature-flags-<env>` (ADR-0007) con el mismo puerto.
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
