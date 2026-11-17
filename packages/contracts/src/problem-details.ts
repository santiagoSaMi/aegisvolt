import { z } from 'zod';

import { correlationIdSchema } from './common/identifiers.ts';

export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

/** Códigos de error estables: MAYÚSCULAS_CON_GUIONES_BAJOS. */
export const errorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/**
 * Formato de error entre servicios (RFC 9457) con extensiones de AegisVolt:
 * `code` estable y legible por máquina, `correlationId` para trazabilidad y,
 * en `VALIDATION_ERROR`, el detalle de cada campo inválido.
 */
export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.int().min(400).max(599),
  code: errorCodeSchema,
  detail: z.string().optional(),
  instance: z.string().optional(),
  correlationId: correlationIdSchema.optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type ProblemDetails = z.output<typeof problemDetailsSchema>;

export function isProblemDetails(value: unknown): value is ProblemDetails {
  return problemDetailsSchema.safeParse(value).success;
}

/**
 * Errores comunes a todas las APIs. Cada API los combina con los suyos en su
 * catálogo `ERROR_CODES` (código → status HTTP).
 */
export const COMMON_ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ROUTE_NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/** Construye el esquema de error de una API restringiendo `code` a su catálogo. */
export function problemSchemaFor<const TCodes extends Readonly<Record<string, number>>>(
  catalog: TCodes,
) {
  const codes = Object.keys(catalog) as [
    Extract<keyof TCodes, string>,
    ...Extract<keyof TCodes, string>[],
  ];
  return problemDetailsSchema.extend({ code: z.enum(codes) });
}
