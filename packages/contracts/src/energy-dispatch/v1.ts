/**
 * Contrato público de energy-dispatch-service, versión 1.
 * Proveedor: energy-dispatch-service. Consumidores: saga-orchestrator-service
 * (activación y aborto) y graphql-api (sesiones y telemetría).
 */
import { z } from 'zod';

import {
  connectorIdSchema,
  sagaIdSchema,
  sessionIdSchema,
  stationIdSchema,
} from '../common/identifiers.ts';
import {
  compensationReasonSchema,
  energyKwhSchema,
  isoDateTimeSchema,
} from '../common/primitives.ts';
import { COMMON_ERROR_CODES, problemDetailsSchema, problemSchemaFor } from '../problem-details.ts';

export const API = {
  name: 'energy-dispatch',
  version: '1.0.0',
  basePath: '/v1',
} as const;

export const paths = {
  session: (sessionId: string) => `${API.basePath}/sessions/${encodeURIComponent(sessionId)}`,
  abortSession: (sessionId: string) =>
    `${API.basePath}/sessions/${encodeURIComponent(sessionId)}/abort`,
  sessionTelemetry: (sessionId: string) =>
    `${API.basePath}/sessions/${encodeURIComponent(sessionId)}/telemetry`,
} as const;

// --- Vocabulario público ---------------------------------------------------

export const SESSION_STATUSES = ['ACTIVE', 'FAILED', 'ABORTED', 'VOIDED', 'COMPLETED'] as const;
export const ABORT_OUTCOMES = ['ABORTED', 'ALREADY_ABORTED', 'ALREADY_FAILED', 'VOIDED'] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUSES);

/** Código de falla del cargador, p. ej. `E-HW-001`. */
export const faultCodeSchema = z.string().regex(/^E-[A-Z]{2,4}-\d{3}$/);

// --- Lecturas y comandos -----------------------------------------------------

export const sessionViewSchema = z.object({
  sessionId: sessionIdSchema,
  sagaId: sagaIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  status: sessionStatusSchema,
  requestedEnergyKwh: energyKwhSchema,
  fault: z.object({ code: faultCodeSchema, simulated: z.boolean() }).optional(),
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema,
});

/**
 * `PUT /v1/sessions/{sessionId}`: activación física del cargador (paso 3, pivote).
 * - 201 ACTIVE · 200 repetición idéntica.
 * - 422 CHARGER_HARDWARE_FAULT (definitivo; `chargerFaultProblemSchema`).
 * - 409 SESSION_ABORTED (tombstone) · 409 IDEMPOTENCY_CONFLICT.
 * Ante un timeout, el orquestador consulta `GET /v1/sessions/{sessionId}` antes de compensar.
 * Cabeceras: `sagaCommandHeadersSchema`.
 */
export const activateSessionRequestSchema = z.strictObject({
  sagaId: sagaIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  energyKwh: energyKwhSchema,
});
export const activateSessionResponseSchema = sessionViewSchema;

/** Problema específico de la falla de hardware, con su código y si fue simulada (flag). */
export const chargerFaultProblemSchema = problemDetailsSchema.extend({
  code: z.literal('CHARGER_HARDWARE_FAULT'),
  status: z.literal(422),
  faultCode: faultCodeSchema,
  simulated: z.boolean(),
});

/**
 * `POST /v1/sessions/{sessionId}/abort` (compensación, idempotente):
 * ABORTED · ALREADY_ABORTED · ALREADY_FAILED · VOIDED (tombstone).
 * 409 SESSION_ALREADY_COMPLETED si la carga ya terminó (no se puede compensar).
 */
export const abortSessionRequestSchema = z.strictObject({ reason: compensationReasonSchema });
export const abortSessionResponseSchema = z.object({
  sessionId: sessionIdSchema,
  status: sessionStatusSchema,
  outcome: z.enum(ABORT_OUTCOMES),
});

export const telemetryRecordViewSchema = z.object({
  sessionId: sessionIdSchema,
  recordedAt: isoDateTimeSchema,
  powerKw: z.number().nonnegative().max(1000),
  energyDeliveredKwh: z.number().nonnegative().max(500),
  voltageV: z.number().nonnegative().max(1500),
  temperatureC: z.number().min(-40).max(120),
});

/** `GET /v1/sessions/{sessionId}/telemetry?limit=` (más reciente primero) */
export const listTelemetryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export const listTelemetryResponseSchema = z.object({
  items: z.array(telemetryRecordViewSchema),
});

// --- Errores ---------------------------------------------------------------

export const ERROR_CODES = {
  ...COMMON_ERROR_CODES,
  SESSION_NOT_FOUND: 404,
  CHARGER_HARDWARE_FAULT: 422,
  SESSION_ABORTED: 409,
  SESSION_ALREADY_COMPLETED: 409,
  IDEMPOTENCY_CONFLICT: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

// --- Tipos -------------------------------------------------------------------

export type SessionView = z.output<typeof sessionViewSchema>;
export type ActivateSessionRequest = z.output<typeof activateSessionRequestSchema>;
export type ChargerFaultProblem = z.output<typeof chargerFaultProblemSchema>;
export type AbortSessionRequest = z.output<typeof abortSessionRequestSchema>;
export type AbortSessionResponse = z.output<typeof abortSessionResponseSchema>;
export type TelemetryRecordView = z.output<typeof telemetryRecordViewSchema>;
