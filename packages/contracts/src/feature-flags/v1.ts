/**
 * Contrato de feature flags, versión 1 (ADR-0007, ADR-0025).
 * - Datos: estado de una flag tal como lo leen los servicios desde
 *   `aegisvolt-feature-flags-<env>`. Único escritor: graphql-api.
 * - Desde 1.1.0, operaciones del módulo de flags del graphql-api
 *   (`GetFeatureFlags`, `UpdateFeatureFlag`, auditoría). Ninguna recibe el
 *   ambiente: el ambiente es el del despliegue que atiende la petición.
 */
import { z } from 'zod';

import { correlationIdSchema } from '../common/identifiers.ts';
import { isoDateTimeSchema } from '../common/primitives.ts';
import { COMMON_ERROR_CODES, problemSchemaFor } from '../problem-details.ts';

export const CONTRACT = { name: 'feature-flags', version: '1.1.0' } as const;

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

/** Ambiente del despliegue (lo fija la configuración, nunca el cliente). */
export const FLAG_ENVIRONMENTS = ['local', 'dev', 'test', 'prod'] as const;
export const flagEnvironmentSchema = z.enum(FLAG_ENVIRONMENTS);

export const featureFlagStateSchema = z.object({
  key: featureFlagKeySchema,
  /** Solo booleanos: una flag no puede transportar secretos ni texto libre. */
  enabled: z.boolean(),
  /** Desde 1.1.0 (opcional): descripción del catálogo. */
  description: z.string().min(1).max(280).optional(),
  version: z.int().positive(),
  updatedAt: isoDateTimeSchema,
  updatedBy: z.string().min(1),
});
export type FeatureFlagState = z.output<typeof featureFlagStateSchema>;

// --- Operaciones del graphql-api (desde 1.1.0) ----------------------------

/**
 * Origen del valor que se muestra:
 * - STORE: leído de la tabla del ambiente;
 * - LAST_KNOWN: la tabla no respondió; último valor leído por este proceso;
 * - DEFAULT: la tabla no respondió o la flag no existe; valor seguro del catálogo.
 */
export const FEATURE_FLAG_SOURCES = ['STORE', 'LAST_KNOWN', 'DEFAULT'] as const;

export const featureFlagViewSchema = z.object({
  key: featureFlagKeySchema,
  enabled: z.boolean(),
  description: z.string().min(1),
  source: z.enum(FEATURE_FLAG_SOURCES),
  version: z.int().positive().optional(),
  updatedAt: isoDateTimeSchema.optional(),
  updatedBy: z.string().min(1).optional(),
});

/** `GetFeatureFlags`: todas las flags del ambiente del despliegue. */
export const featureFlagsViewSchema = z.object({
  environment: flagEnvironmentSchema,
  flags: z.array(featureFlagViewSchema),
  /** true si algún valor no viene de la tabla (fuente no disponible). */
  degraded: z.boolean(),
  readAt: isoDateTimeSchema,
});

/**
 * `UpdateFeatureFlag(key, …)` (solo `platform-admins`). `expectedVersion`
 * opcional: si se envía y no coincide → 409 FEATURE_FLAG_VERSION_CONFLICT.
 * Fijar el valor que ya tiene no cambia nada ni genera auditoría.
 */
export const updateFeatureFlagRequestSchema = z.strictObject({
  enabled: z.boolean(),
  expectedVersion: z.int().positive().optional(),
});

/** Registro de auditoría: quién, cuándo y qué cambió (y en qué ambiente). */
export const featureFlagChangeViewSchema = z.object({
  key: featureFlagKeySchema,
  from: z.boolean(),
  to: z.boolean(),
  version: z.int().positive(),
  changedBy: z.string().min(1),
  changedAt: isoDateTimeSchema,
  correlationId: correlationIdSchema,
  environment: flagEnvironmentSchema,
});

export const updateFeatureFlagResponseSchema = z.object({
  flag: featureFlagViewSchema,
  changed: z.boolean(),
  change: featureFlagChangeViewSchema.optional(),
});

export const ERROR_CODES = {
  ...COMMON_ERROR_CODES,
  FEATURE_FLAG_NOT_FOUND: 404,
  FEATURE_FLAG_VERSION_CONFLICT: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

export type FeatureFlagView = z.output<typeof featureFlagViewSchema>;
export type FeatureFlagsView = z.output<typeof featureFlagsViewSchema>;
export type UpdateFeatureFlagRequest = z.output<typeof updateFeatureFlagRequestSchema>;
export type FeatureFlagChangeView = z.output<typeof featureFlagChangeViewSchema>;
