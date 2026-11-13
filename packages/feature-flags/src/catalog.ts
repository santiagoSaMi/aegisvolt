import type { FeatureFlagKey } from './reader.ts';

/** Ambientes con tabla de flags propia (`local` es el de desarrollo en Floci). */
export const FLAG_ENVIRONMENTS = ['local', 'dev', 'test', 'prod'] as const;
export type FlagEnvironment = (typeof FLAG_ENVIRONMENTS)[number];

export interface FeatureFlagDefinition {
  readonly key: FeatureFlagKey;
  /** Qué hace la flag (se guarda con la flag y se muestra en el frontend). */
  readonly description: string;
  /** Servicio que la evalúa (contrato featureFlagsV1). */
  readonly evaluatedBy: string;
  /**
   * Valor si la flag no existe o el almacén no responde y no hay último valor
   * conocido. Siempre el que NO cambia el comportamiento base: sin recargo, sin
   * capacidades extra, sin fallos inducidos.
   */
  readonly safeDefault: false;
  /** Valor inicial sembrado en cada ambiente (Terraform; en local, el script de siembra). */
  readonly initial: Readonly<Record<FlagEnvironment, boolean>>;
}

/**
 * Catálogo ÚNICO de flags (ADR-0025). Las flags solo son booleanas: no admiten
 * texto libre, así que no pueden transportar secretos ni configuración sensible.
 *
 * Valores iniciales:
 * - `ENABLE_DYNAMIC_SURGE_PRICING`: los de §2.2 de la especificación.
 * - `SIMULATE_CHARGER_HARDWARE_FAULT`: los de la fase de feature flags; `test`
 *   empieza activa para la demostración de §6.3.
 * - `ENABLE_FAST_CHARGE_BOOST`: la especificación no define su efecto. El
 *   comportamiento propuesto (P-14) está documentado e implementado en
 *   station-reservation; solo se activa en `dev` hasta que se acepte esa
 *   interpretación. Activarla en `test` o `prod` es un cambio operativo
 *   auditado, sin redesplegar.
 */
export const FEATURE_FLAG_CATALOG: readonly FeatureFlagDefinition[] = [
  {
    key: 'ENABLE_DYNAMIC_SURGE_PRICING',
    description:
      'Aplica el multiplicador de tarifa dinámica en las ventanas pico configuradas (billing-wallet).',
    evaluatedBy: 'billing-wallet-service',
    safeDefault: false,
    initial: { local: true, dev: true, test: true, prod: false },
  },
  {
    key: 'ENABLE_FAST_CHARGE_BOOST',
    description:
      'Permite reservas con fastChargeBoost: conectores ultra rápidos (≥ 150 kW) y hold extendido (station-reservation, P-14).',
    evaluatedBy: 'station-reservation-service',
    safeDefault: false,
    initial: { local: true, dev: true, test: false, prod: false },
  },
  {
    key: 'SIMULATE_CHARGER_HARDWARE_FAULT',
    description:
      'Fuerza una falla física simulada (E-HW-001) al activar el cargador para demostrar la compensación de la SAGA (energy-dispatch).',
    evaluatedBy: 'energy-dispatch-service',
    safeDefault: false,
    initial: { local: false, dev: false, test: true, prod: false },
  },
];

export function definitionOf(key: FeatureFlagKey): FeatureFlagDefinition {
  const definition = FEATURE_FLAG_CATALOG.find((d) => d.key === key);
  if (definition === undefined) {
    throw new Error(`Flag desconocida: ${key}`);
  }
  return definition;
}
