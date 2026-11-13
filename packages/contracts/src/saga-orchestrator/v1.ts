/**
 * Contrato público de saga-orchestrator-service, versión 1.
 * Proveedor: saga-orchestrator-service. Consumidor: graphql-api.
 */
import { z } from 'zod';

import {
  connectorIdSchema,
  correlationIdSchema,
  fleetIdSchema,
  sagaIdSchema,
  stationIdSchema,
} from '../common/identifiers.ts';
import { energyKwhSchema, isoDateTimeSchema } from '../common/primitives.ts';
import { COMMON_ERROR_CODES, errorCodeSchema, problemSchemaFor } from '../problem-details.ts';

export const API = {
  name: 'saga-orchestrator',
  version: '1.0.0',
  basePath: '/v1',
} as const;

export const paths = {
  sagas: () => `${API.basePath}/sagas`,
  saga: (sagaId: string) => `${API.basePath}/sagas/${encodeURIComponent(sagaId)}`,
  sagaEvents: (sagaId: string) => `${API.basePath}/sagas/${encodeURIComponent(sagaId)}/events`,
} as const;

// --- Vocabulario público ---------------------------------------------------

export const SAGA_STATUSES = [
  'STARTED',
  'RESERVING',
  'DEBITING',
  'ACTIVATING',
  'CONFIRMING',
  'COMPENSATING',
  'COMPENSATION_PENDING',
  'COMPLETED',
  'COMPENSATED',
  'FAILED',
  'REQUIRES_ATTENTION',
] as const;
export const TERMINAL_SAGA_STATUSES = [
  'COMPLETED',
  'COMPENSATED',
  'FAILED',
  'REQUIRES_ATTENTION',
] as const;
export const SAGA_STEPS = [
  'RESERVATION',
  'DEBIT',
  'ACTIVATION',
  'CONFIRMATION',
  'ABORT_SESSION',
  'REFUND_DEBIT',
  'RELEASE_RESERVATION',
] as const;
export const SAGA_STEP_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export const SAGA_FAILURE_REASONS = [
  'CONNECTOR_UNAVAILABLE',
  'FAST_CHARGE_BOOST_DISABLED',
  'ULTRA_FAST_REQUIRES_BOOST',
  'INSUFFICIENT_FUNDS',
  'CHARGER_HARDWARE_FAULT',
  'STEP_RETRIES_EXHAUSTED',
  'RECOVERY_DEADLINE_EXCEEDED',
] as const;
export const SAGA_EVENT_TYPES = [
  'SAGA_STARTED',
  'STEP_STARTED',
  'STEP_SUCCEEDED',
  'STEP_FAILED',
  'COMPENSATION_STARTED',
  'COMPENSATION_SUCCEEDED',
  'COMPENSATION_FAILED',
  'SAGA_COMPLETED',
  'SAGA_COMPENSATED',
  'SAGA_FAILED',
  'SAGA_REQUIRES_ATTENTION',
  'RECOVERED',
] as const;

export const sagaStatusSchema = z.enum(SAGA_STATUSES);
export const sagaStepSchema = z.enum(SAGA_STEPS);
export const sagaFailureReasonSchema = z.enum(SAGA_FAILURE_REASONS);

// --- Comandos y lecturas -----------------------------------------------------

/**
 * `POST /v1/sagas`: inicia "Reservar y Activar Carga".
 * Cabeceras: `idempotentCommandHeadersSchema` (`idempotency-key` por acción del usuario).
 * - 201: la SAGA terminó dentro de la espera síncrona (COMPLETED/COMPENSATED/FAILED…).
 * - 202: sigue en curso; consultar `GET /v1/sagas/{sagaId}`.
 * - Repetir con la misma clave devuelve la misma SAGA (mismo status HTTP según su estado).
 * - 409 IDEMPOTENCY_KEY_CONFLICT: misma clave con otro cuerpo.
 */
export const startSagaRequestSchema = z.strictObject({
  fleetId: fleetIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  requestedEnergyKwh: energyKwhSchema,
  fastChargeBoost: z.boolean().default(false),
});

export const sagaStepViewSchema = z.object({
  step: sagaStepSchema,
  status: z.enum(SAGA_STEP_STATUSES),
  attempts: z.int().nonnegative(),
  lastErrorCode: errorCodeSchema.optional(),
  updatedAt: isoDateTimeSchema,
});

export const sagaViewSchema = z.object({
  sagaId: sagaIdSchema,
  status: sagaStatusSchema,
  terminal: z.boolean(),
  fleetId: fleetIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  requestedEnergyKwh: energyKwhSchema,
  fastChargeBoost: z.boolean(),
  correlationId: correlationIdSchema,
  failureReason: sagaFailureReasonSchema.optional(),
  steps: z.array(sagaStepViewSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export const startSagaResponseSchema = sagaViewSchema;

/** `GET /v1/sagas?fleetId=&status=&limit=` (más reciente primero) */
export const listSagasQuerySchema = z.strictObject({
  fleetId: fleetIdSchema,
  status: sagaStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const listSagasResponseSchema = z.object({ items: z.array(sagaViewSchema) });

/** `GET /v1/sagas/{sagaId}/events`: historial (panel de compensaciones del frontend). */
export const sagaEventViewSchema = z.object({
  sequence: z.int().nonnegative(),
  type: z.enum(SAGA_EVENT_TYPES),
  step: sagaStepSchema.optional(),
  occurredAt: isoDateTimeSchema,
  errorCode: errorCodeSchema.optional(),
});
export const listSagaEventsResponseSchema = z.object({ items: z.array(sagaEventViewSchema) });

// --- Errores ---------------------------------------------------------------

export const ERROR_CODES = {
  ...COMMON_ERROR_CODES,
  SAGA_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

// --- Tipos -------------------------------------------------------------------

export type SagaStatus = z.output<typeof sagaStatusSchema>;
export type StartSagaRequest = z.output<typeof startSagaRequestSchema>;
export type SagaView = z.output<typeof sagaViewSchema>;
export type SagaEventView = z.output<typeof sagaEventViewSchema>;
