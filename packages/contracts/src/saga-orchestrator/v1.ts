/**
 * Contrato público de saga-orchestrator-service, versión 1.
 * Proveedor: saga-orchestrator-service. Consumidor: graphql-api.
 */
import { z } from 'zod';

import {
  connectorIdSchema,
  correlationIdSchema,
  debitIdSchema,
  fleetIdSchema,
  reservationIdSchema,
  sagaIdSchema,
  sessionIdSchema,
  stationIdSchema,
} from '../common/identifiers.ts';
import { energyKwhSchema, isoDateTimeSchema, powerKwSchema } from '../common/primitives.ts';
import { COMMON_ERROR_CODES, errorCodeSchema, problemSchemaFor } from '../problem-details.ts';

export const API = {
  name: 'saga-orchestrator',
  version: '1.1.0',
  basePath: '/v1',
} as const;

const enc = encodeURIComponent;

export const paths = {
  sagas: () => `${API.basePath}/sagas`,
  saga: (sagaId: string) => `${API.basePath}/sagas/${enc(sagaId)}`,
  sagaEvents: (sagaId: string) => `${API.basePath}/sagas/${enc(sagaId)}/events`,
  retryCompensation: (sagaId: string) => `${API.basePath}/sagas/${enc(sagaId)}/compensation/retry`,
} as const;

// --- Vocabulario público ---------------------------------------------------

/**
 * 1.1.0 (corrección *pre-release*): estados por hito alcanzado.
 * - STARTED → RESERVATION_COMPLETED → BILLING_COMPLETED → DISPATCH_COMPLETED → COMPLETED.
 * - COMPENSATING → COMPENSATED (compensaciones verificadas) o COMPENSATION_FAILED
 *   (una compensación falló; recuperable por el worker o por reintento controlado).
 * - FAILED: falló sin efectos que compensar (p. ej. la reserva fue rechazada).
 */
export const SAGA_STATUSES = [
  'STARTED',
  'RESERVATION_COMPLETED',
  'BILLING_COMPLETED',
  'DISPATCH_COMPLETED',
  'COMPLETED',
  'COMPENSATING',
  'COMPENSATED',
  'FAILED',
  'COMPENSATION_FAILED',
] as const;
export const TERMINAL_SAGA_STATUSES = ['COMPLETED', 'COMPENSATED', 'FAILED'] as const;
export const SAGA_STEPS = [
  'RESERVATION',
  'DEBIT',
  'ACTIVATION',
  'CONFIRMATION',
  'ABORT_SESSION',
  'REFUND_DEBIT',
  'RELEASE_RESERVATION',
] as const;
/** IN_PROGRESS se persiste ANTES de llamar al servicio (permite reanudar tras un reinicio). */
export const SAGA_STEP_STATUSES = ['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED'] as const;
export const SAGA_FAILURE_REASONS = [
  // Rechazos de negocio definitivos (no se reintentan)
  'STATION_NOT_FOUND',
  'CONNECTOR_NOT_FOUND',
  'CONNECTOR_UNAVAILABLE',
  'FAST_CHARGE_BOOST_DISABLED',
  'ULTRA_FAST_REQUIRES_BOOST',
  'WALLET_NOT_FOUND',
  'INSUFFICIENT_FUNDS',
  'CHARGER_HARDWARE_FAULT',
  'CONNECTOR_BUSY',
  'RESERVATION_HOLD_EXPIRED',
  'RESERVATION_NOT_HELD',
  // Respuesta no recuperable inesperada (p. ej. 400/409 de idempotencia)
  'STEP_REJECTED',
  // Abandono técnico: resultado desconocido
  'STEP_RETRIES_EXHAUSTED',
  'RECOVERY_DEADLINE_EXCEEDED',
] as const;
export const SAGA_EVENT_TYPES = [
  'SAGA_STARTED',
  'STEP_STARTED',
  'STEP_SUCCEEDED',
  'STEP_FAILED',
  'COMPENSATION_STARTED',
  'COMPENSATION_STEP_STARTED',
  'COMPENSATION_SUCCEEDED',
  'COMPENSATION_STEP_FAILED',
  'COMPENSATION_RETRY_REQUESTED',
  'SAGA_COMPLETED',
  'SAGA_COMPENSATED',
  'SAGA_FAILED',
  'SAGA_COMPENSATION_FAILED',
  'RECOVERED',
] as const;

export const sagaStatusSchema = z.enum(SAGA_STATUSES);
export const sagaStepSchema = z.enum(SAGA_STEPS);
export const sagaFailureReasonSchema = z.enum(SAGA_FAILURE_REASONS);

// --- Comandos y lecturas -----------------------------------------------------

/**
 * `POST /v1/sagas`: inicia "Reservar y Activar Carga" (`ReserveAndActivateCharging`).
 * Cabeceras: `idempotentCommandHeadersSchema` (`idempotency-key` por acción del
 * usuario; el id de la SAGA se deriva de ella: `saga_<idempotency-key>`).
 * - 201: la SAGA terminó (COMPLETED / COMPENSATED / FAILED).
 * - 202: no terminó (COMPENSATION_FAILED con reintento programado, o la ejecuta
 *   otra réplica); consultar `GET /v1/sagas/{sagaId}`.
 * - Repetir con la misma clave devuelve la misma SAGA y, si quedó a medias y nadie
 *   la ejecuta, la reanuda (nunca crea otra).
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
  /** Clave idempotente ESTABLE del paso (id pre-generado o clave de compensación). */
  idempotencyKey: z.string().min(1),
  lastErrorCode: errorCodeSchema.optional(),
  updatedAt: isoDateTimeSchema,
});

/** Compensación que falló (estado COMPENSATION_FAILED): paso, error y siguiente intento. */
export const compensationFailureViewSchema = z.object({
  step: sagaStepSchema,
  errorCode: errorCodeSchema,
  detail: z.string().optional(),
  round: z.int().positive(),
  failedAt: isoDateTimeSchema,
  /** Ausente: se agotaron los reintentos automáticos; requiere reintento controlado. */
  nextAttemptAt: isoDateTimeSchema.optional(),
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
  /** Desde 1.1.0: ids pre-generados de los recursos de cada paso. */
  reservationId: reservationIdSchema,
  debitId: debitIdSchema,
  sessionId: sessionIdSchema,
  connectorPowerKw: powerKwSchema.optional(),
  failureReason: sagaFailureReasonSchema.optional(),
  failedStep: sagaStepSchema.optional(),
  compensationPlan: z.array(sagaStepSchema),
  compensationFailure: compensationFailureViewSchema.optional(),
  steps: z.array(sagaStepViewSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export const startSagaResponseSchema = sagaViewSchema;

/**
 * `POST /v1/sagas/{sagaId}/compensation/retry` (desde 1.1.0): reintento
 * CONTROLADO de una SAGA en COMPENSATION_FAILED (operador o tarea de recuperación).
 * 200 terminal · 202 no terminó · 409 SAGA_NOT_RETRYABLE · 409 SAGA_BUSY (otra réplica la ejecuta).
 */
export const retryCompensationResponseSchema = sagaViewSchema;

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
  /** Desde 1.1.0: estado de la SAGA tras el evento y número de intento. */
  status: sagaStatusSchema,
  attempt: z.int().positive().optional(),
  occurredAt: isoDateTimeSchema,
  errorCode: errorCodeSchema.optional(),
  correlationId: correlationIdSchema,
});
export const listSagaEventsResponseSchema = z.object({ items: z.array(sagaEventViewSchema) });

// --- Errores ---------------------------------------------------------------

export const ERROR_CODES = {
  ...COMMON_ERROR_CODES,
  SAGA_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  // Desde 1.1.0
  SAGA_NOT_RETRYABLE: 409,
  SAGA_BUSY: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

// --- Tipos -------------------------------------------------------------------

export type SagaStatus = z.output<typeof sagaStatusSchema>;
export type StartSagaRequest = z.output<typeof startSagaRequestSchema>;
export type SagaView = z.output<typeof sagaViewSchema>;
export type SagaEventView = z.output<typeof sagaEventViewSchema>;
