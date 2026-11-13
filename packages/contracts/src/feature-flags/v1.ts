/**
 * Contrato de datos de feature flags, versión 1 (ADR-0007).
 * No es una API HTTP: describe el estado de una flag tal como lo leen los
 * servicios desde `aegisvolt-feature-flags-<env>`. Único escritor: graphql-api.
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '../common/primitives.ts';

export const CONTRACT = { name: 'feature-flags', version: '1.0.0' } as const;

/** Flags obligatorias de la especificación (§2.2). Añadir una flag es un cambio *minor*. */
export const FEATURE_FLAG_KEYS = [
  'ENABLE_DYNAMIC_SURGE_PRICING',
  'ENABLE_FAST_CHARGE_BOOST',
  'SIMULATE_CHARGER_HARDWARE_FAULT',
] as const;
export const featureFlagKeySchema = z.enum(FEATURE_FLAG_KEYS);
export type FeatureFlagKey = z.output<typeof featureFlagKeySchema>;

/** Servicio que evalúa cada flag (documental; ver 03-feature-flags-y-seguridad.md). */
export const FEATURE_FLAG_EVALUATORS = {
  ENABLE_DYNAMIC_SURGE_PRICING: 'billing-wallet-service',
  ENABLE_FAST_CHARGE_BOOST: 'station-reservation-service',
  SIMULATE_CHARGER_HARDWARE_FAULT: 'energy-dispatch-service',
} as const satisfies Record<FeatureFlagKey, string>;

export const featureFlagStateSchema = z.object({
  key: featureFlagKeySchema,
  enabled: z.boolean(),
  version: z.int().positive(),
  updatedAt: isoDateTimeSchema,
  updatedBy: z.string().min(1),
});
export type FeatureFlagState = z.output<typeof featureFlagStateSchema>;
