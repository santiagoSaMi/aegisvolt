/** Reloj inyectable (ventanas pico de la política de precios, fechas de auditoría). */
export interface Clock {
  now(): Date;
}

/** Flags que evalúa este servicio (contrato featureFlagsV1, ADR-0007). */
export type BillingFlag = 'ENABLE_DYNAMIC_SURGE_PRICING';

export interface FeatureFlagReader {
  isEnabled(flag: BillingFlag): Promise<boolean>;
}

/** Trazabilidad que la presentación extrae de la petición. */
export interface RequestAudit {
  readonly correlationId: string;
  /** Clave idempotente con la que se pidió la operación. */
  readonly idempotencyKey: string;
}
