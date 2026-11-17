import { z } from 'zod';

/** Instante en ISO-8601, siempre en UTC con sufijo `Z` (p. ej. `2026-11-13T15:04:05.000Z`). */
export const isoDateTimeSchema = z.iso.datetime();

/** Energía en kWh: positiva, máximo 500 kWh por sesión y 3 decimales (resolución de 1 Wh). */
export const energyKwhSchema = z.number().positive().max(500).multipleOf(0.001);

/** Potencia en kW: positiva, máximo 1000 kW. */
export const powerKwSchema = z.number().positive().max(1000);

/** Código de moneda ISO 4217 (p. ej. `COP`). */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, {
  error: 'Debe ser un código ISO 4217 de 3 letras mayúsculas',
});

/**
 * Importe monetario en unidades menores (enteros), para evitar errores de coma
 * flotante (ADR-0006). Ejemplo: 125000 COP = `{ amountMinor: 12500000, currency: 'COP' }`.
 */
export const moneySchema = z.object({
  amountMinor: z.int().nonnegative(),
  currency: currencyCodeSchema,
});
export type Money = z.output<typeof moneySchema>;

/** Importe estrictamente positivo (cargos, recargas). */
export const positiveMoneySchema = moneySchema.extend({ amountMinor: z.int().positive() });

/** Ciudad como *slug* estable en minúsculas (p. ej. `bogota`, `medellin`). */
export const citySchema = z.string().regex(/^[a-z]+(-[a-z]+)*$/, {
  error: 'Debe ser un slug en minúsculas (p. ej. bogota)',
});

/** Paginación por cursor opaco. */
export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});

/**
 * Motivo de una compensación, compartido por las operaciones `release`, `refund`
 * y `abort` para que el historial de la SAGA sea homogéneo.
 */
export const COMPENSATION_REASONS = [
  'INSUFFICIENT_FUNDS',
  'CHARGER_HARDWARE_FAULT',
  'FORWARD_STEP_FAILED',
  'RECOVERY_DEADLINE_EXCEEDED',
  'OPERATOR_REQUEST',
] as const;
export const compensationReasonSchema = z.enum(COMPENSATION_REASONS);
export type CompensationReason = z.output<typeof compensationReasonSchema>;
