import type { featureFlagsV1 } from '@aegisvolt/contracts';

export type FeatureFlagKey = featureFlagsV1.FeatureFlagKey;
export type FeatureFlagState = featureFlagsV1.FeatureFlagState;

/**
 * Puerto de lectura de flags. Cada servicio declara en su capa de aplicación un
 * puerto propio, más estrecho, con las flags que evalúa; este lector lo satisface
 * por tipado estructural sin que la aplicación dependa de este paquete.
 */
export interface FeatureFlagReader {
  isEnabled(key: FeatureFlagKey): Promise<boolean>;
}

/** Almacén de flags del ambiente (en AegisVolt, `aegisvolt-feature-flags-<env>`). */
export interface FeatureFlagSource {
  /** Estado de la flag, o `undefined` si no existe en el almacén. */
  fetch(key: FeatureFlagKey): Promise<FeatureFlagState | undefined>;
}

/** El ítem leído no cumple el contrato `featureFlagsV1.featureFlagStateSchema`. */
export class InvalidFeatureFlagError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidFeatureFlagError';
  }
}
