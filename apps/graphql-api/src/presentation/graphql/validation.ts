import {
  citySchema,
  connectorIdSchema,
  energyKwhSchema,
  fleetIdSchema,
  idempotencyKeySchema,
  reservationIdSchema,
  sagaIdSchema,
  sessionIdSchema,
  stationIdSchema,
} from '@aegisvolt/contracts';
import { z } from 'zod';

/**
 * Validación de argumentos en el borde (además de los tipos del esquema): formatos
 * de ids, rangos y límites de paginación. Un fallo → BAD_USER_INPUT con el detalle
 * por campo. Los esquemas de ids son los mismos del contrato de cada servicio.
 */
export class InputValidationError extends Error {
  readonly fields: readonly { path: string; message: string }[];

  constructor(fields: readonly { path: string; message: string }[]) {
    super('Argumentos inválidos');
    this.name = 'InputValidationError';
    this.fields = fields;
  }
}

export function parseArgs<TSchema extends z.ZodType>(
  schema: TSchema,
  args: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new InputValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Límite de página: 1–50 (por defecto 20). */
const first = z.number().int().min(1).max(50).default(20);
const after = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .nullable()
  .transform((v) => v ?? undefined);
const optionalFleet = fleetIdSchema
  .optional()
  .nullable()
  .transform((v) => v ?? undefined);

export const argsSchemas = {
  stations: z.object({ city: citySchema }),
  stationById: z.object({ stationId: stationIdSchema }),
  availableConnectors: z
    .object({
      city: citySchema.optional().nullable(),
      stationId: stationIdSchema.optional().nullable(),
    })
    .transform((v) => ({ city: v.city ?? undefined, stationId: v.stationId ?? undefined }))
    .refine((v) => (v.city === undefined) !== (v.stationId === undefined), {
      error: 'Indique exactamente uno de city o stationId',
    }),
  fleetScoped: z.object({ fleetId: optionalFleet }),
  fleetPage: z.object({ fleetId: optionalFleet, first, after }),
  chargingSessions: z.object({
    stationId: stationIdSchema,
    active: z.boolean().default(false),
    first,
    after,
  }),
  sessionById: z.object({ sessionId: sessionIdSchema }),
  telemetry: z.object({ last: z.number().int().min(1).max(100).default(10) }),
  sagaStatus: z.object({ sagaId: sagaIdSchema }),
  chargingEstimate: z.object({
    fleetId: optionalFleet,
    stationId: stationIdSchema,
    connectorId: connectorIdSchema,
    requestedEnergyKwh: energyKwhSchema,
  }),
  sagas: z.object({
    fleetId: optionalFleet,
    status: z
      .string()
      .optional()
      .nullable()
      .transform((v) => v ?? undefined),
    first,
  }),
  reserveAndActivateCharging: z.object({
    input: z.object({
      idempotencyKey: idempotencyKeySchema,
      fleetId: optionalFleet,
      stationId: stationIdSchema,
      connectorId: connectorIdSchema,
      requestedEnergyKwh: energyKwhSchema,
      fastChargeBoost: z
        .boolean()
        .nullable()
        .default(false)
        .transform((v) => v ?? false),
    }),
  }),
  releaseReservation: z.object({ reservationId: reservationIdSchema }),
  updateFeatureFlag: z.object({
    input: z.object({
      key: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, { error: 'Clave de flag inválida' }),
      enabled: z.boolean(),
      expectedVersion: z
        .number()
        .int()
        .min(1)
        .optional()
        .nullable()
        .transform((v) => v ?? undefined),
    }),
  }),
};
