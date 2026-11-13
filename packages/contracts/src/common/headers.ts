import { z } from 'zod';

import { HTTP_HEADERS } from '../http-headers.ts';
import { correlationIdSchema, idempotencyKeySchema, sagaIdSchema } from './identifiers.ts';

/**
 * Esquemas de cabeceras. Se validan sobre el objeto de cabeceras de Node.js
 * (nombres en minúsculas); las cabeceras no listadas se ignoran.
 */

/** Toda llamada entre servicios lleva `x-correlation-id`. */
export const correlationHeadersSchema = z.object({
  [HTTP_HEADERS.correlationId]: correlationIdSchema,
});

/** Comandos de la SAGA (orquestador → servicios): además `x-saga-id`. */
export const sagaCommandHeadersSchema = correlationHeadersSchema.extend({
  [HTTP_HEADERS.sagaId]: sagaIdSchema,
});

/** Comandos no idempotentes por naturaleza (POST): además `idempotency-key`. */
export const idempotentCommandHeadersSchema = correlationHeadersSchema.extend({
  [HTTP_HEADERS.idempotencyKey]: idempotencyKeySchema,
});

export type CorrelationHeaders = z.output<typeof correlationHeadersSchema>;
export type SagaCommandHeaders = z.output<typeof sagaCommandHeadersSchema>;
export type IdempotentCommandHeaders = z.output<typeof idempotentCommandHeadersSchema>;
