/**
 * Contrato público de energy-dispatch-service, versión 1.
 * Proveedor: energy-dispatch-service. Consumidores: saga-orchestrator-service
 * (activación y aborto) y graphql-api (sesiones, parada, cargadores y telemetría).
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
  paginationQuerySchema,
} from '../common/primitives.ts';
import { COMMON_ERROR_CODES, problemDetailsSchema, problemSchemaFor } from '../problem-details.ts';

export const API = {
  name: 'energy-dispatch',
  version: '1.1.0',
  basePath: '/v1',
} as const;

const enc = encodeURIComponent;

export const paths = {
  session: (sessionId: string) => `${API.basePath}/sessions/${enc(sessionId)}`,
  abortSession: (sessionId: string) => `${API.basePath}/sessions/${enc(sessionId)}/abort`,
  stopSession: (sessionId: string) => `${API.basePath}/sessions/${enc(sessionId)}/stop`,
  sessionTelemetry: (sessionId: string) => `${API.basePath}/sessions/${enc(sessionId)}/telemetry`,
  stationSessions: (stationId: string) => `${API.basePath}/stations/${enc(stationId)}/sessions`,
  chargerStatus: (stationId: string, connectorId: string) =>
    `${API.basePath}/stations/${enc(stationId)}/connectors/${enc(connectorId)}/charger`,
} as const;

// --- Vocabulario público ---------------------------------------------------

export const SESSION_STATUSES = ['ACTIVE', 'FAILED', 'ABORTED', 'VOIDED', 'COMPLETED'] as const;
export const ABORT_OUTCOMES = ['ABORTED', 'ALREADY_ABORTED', 'ALREADY_FAILED', 'VOIDED'] as const;
export const STOP_REASONS = ['USER_REQUEST', 'TARGET_REACHED', 'OPERATOR_REQUEST'] as const;
export const STOP_OUTCOMES = ['STOPPED', 'ALREADY_STOPPED'] as const;
/** Estado operativo de un cargador: cargando, libre o con falla de hardware. */
export const CHARGER_STATES = ['CHARGING', 'IDLE', 'FAULTED'] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export const stopReasonSchema = z.enum(STOP_REASONS);

/** Código de falla del cargador, p. ej. `E-HW-001`. */
export const faultCodeSchema = z.string().regex(/^E-[A-Z]{2,4}-\d{3}$/);

const chargerFaultSchema = z.object({ code: faultCodeSchema, simulated: z.boolean() });

// --- Sesiones ----------------------------------------------------------------

/** Transición de estado registrada (auditoría del ciclo de vida). */
export const sessionTransitionViewSchema = z.object({
  from: sessionStatusSchema.optional(),
  to: sessionStatusSchema,
  at: isoDateTimeSchema,
  reason: z.string().optional(),
});

export const sessionViewSchema = z.object({
  sessionId: sessionIdSchema,
  sagaId: sagaIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  status: sessionStatusSchema,
  requestedEnergyKwh: energyKwhSchema,
  fault: chargerFaultSchema.optional(),
  /** Desde 1.1.0: motivo de la parada (solo COMPLETED). */
  stopReason: stopReasonSchema.optional(),
  /** Desde 1.1.0: energía acumulada según la última lectura de telemetría. */
  energyDeliveredKwh: z.number().nonnegative().max(500).optional(),
  /** Desde 1.1.0: instante de la última lectura de telemetría. */
  lastTelemetryAt: isoDateTimeSchema.optional(),
  /** Desde 1.1.0: transiciones de estado, en orden. */
  transitions: z.array(sessionTransitionViewSchema).optional(),
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema,
});

/**
 * `PUT /v1/sessions/{sessionId}`: activación física del cargador (paso 3, pivote).
 * - 201 ACTIVE · 200 repetición idéntica.
 * - 422 CHARGER_HARDWARE_FAULT: falla FÍSICA, definitiva (`chargerFaultProblemSchema`).
 * - 503 CHARGER_UNAVAILABLE: fallo TÉCNICO (sin comunicación), reintentable.
 * - 409 SESSION_ABORTED (tombstone) · 409 IDEMPOTENCY_CONFLICT · 409 CONNECTOR_BUSY.
 * Ante un timeout o un 503, el orquestador consulta `GET /v1/sessions/{sessionId}` antes de compensar.
 * Cabeceras: `sagaCommandHeadersSchema`.
 */
export const activateSessionRequestSchema = z.strictObject({
  sagaId: sagaIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  energyKwh: energyKwhSchema,
});
export const activateSessionResponseSchema = sessionViewSchema;

/**
 * Problema específico de la falla de hardware: código de falla, si fue simulada
 * (flag `SIMULATE_CHARGER_HARDWARE_FAULT`) y, desde 1.1.0, la sesión FAILED registrada.
 */
export const chargerFaultProblemSchema = problemDetailsSchema.extend({
  code: z.literal('CHARGER_HARDWARE_FAULT'),
  status: z.literal(422),
  faultCode: faultCodeSchema,
  simulated: z.boolean(),
  sessionId: sessionIdSchema.optional(),
});

/**
 * `POST /v1/sessions/{sessionId}/abort` (compensación, idempotente):
 * ABORTED · ALREADY_ABORTED · ALREADY_FAILED · VOIDED (tombstone).
 * 409 SESSION_ALREADY_COMPLETED si la carga ya terminó (no se puede compensar).
 * Cabeceras: `sagaCommandHeadersSchema`.
 */
export const abortSessionRequestSchema = z.strictObject({ reason: compensationReasonSchema });
export const abortSessionResponseSchema = z.object({
  sessionId: sessionIdSchema,
  status: sessionStatusSchema,
  outcome: z.enum(ABORT_OUTCOMES),
});

/**
 * `POST /v1/sessions/{sessionId}/stop` (desde 1.1.0): parada normal, idempotente.
 * STOPPED · ALREADY_STOPPED. 409 SESSION_NOT_ACTIVE si la sesión FAILED o ABORTED.
 */
export const stopSessionRequestSchema = z.strictObject({
  reason: stopReasonSchema.default('USER_REQUEST'),
});
export const stopSessionResponseSchema = z.object({
  sessionId: sessionIdSchema,
  status: sessionStatusSchema,
  outcome: z.enum(STOP_OUTCOMES),
});

/**
 * `GET /v1/stations/{stationId}/sessions?active=&limit=&cursor=` (desde 1.1.0):
 * `active=true` → sesiones ACTIVE; si no, el histórico de la estación (más reciente primero).
 */
export const listStationSessionsQuerySchema = paginationQuerySchema.extend({
  active: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export const listSessionsResponseSchema = z.object({
  items: z.array(sessionViewSchema),
  nextCursor: z.string().optional(),
});

// --- Cargadores ----------------------------------------------------------------

/** `GET /v1/stations/{stationId}/connectors/{connectorId}/charger` (desde 1.1.0). */
export const chargerStatusViewSchema = z.object({
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  state: z.enum(CHARGER_STATES),
  activeSessionId: sessionIdSchema.optional(),
  fault: chargerFaultSchema.optional(),
  checkedAt: isoDateTimeSchema,
});

// --- Telemetría ----------------------------------------------------------------

/**
 * Lectura del cargador. Campos mínimos: `sessionId`, `voltageV`, `currentA`,
 * `powerKw`, `energyKwh` (acumulada en la sesión) y `timestamp`.
 * 1.1.0 (corrección *pre-release*): `recordedAt` → `timestamp`,
 * `energyDeliveredKwh` → `energyKwh`, nuevo `currentA`, `temperatureC` opcional.
 */
const telemetryReadingShape = {
  timestamp: isoDateTimeSchema,
  voltageV: z.number().nonnegative().max(1500),
  currentA: z.number().nonnegative().max(1000),
  powerKw: z.number().nonnegative().max(1000),
  energyKwh: z.number().nonnegative().max(500),
  temperatureC: z.number().min(-40).max(120).optional(),
};

/**
 * `POST /v1/sessions/{sessionId}/telemetry` (desde 1.1.0): registra una lectura.
 * 201 nueva · 200 repetición idéntica (mismo `timestamp`).
 * 400 VALIDATION_ERROR (rangos o `powerKw` incoherente con V × I) ·
 * 409 SESSION_NOT_ACTIVE · 409 TELEMETRY_OUT_OF_ORDER · 409 IDEMPOTENCY_CONFLICT.
 */
export const recordTelemetryRequestSchema = z.strictObject(telemetryReadingShape);

export const telemetryRecordViewSchema = z.object({
  sessionId: sessionIdSchema,
  ...telemetryReadingShape,
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
  // Desde 1.1.0
  SESSION_NOT_ACTIVE: 409,
  CONNECTOR_BUSY: 409,
  TELEMETRY_OUT_OF_ORDER: 409,
  CHARGER_UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

// --- Tipos -------------------------------------------------------------------

export type SessionView = z.output<typeof sessionViewSchema>;
export type ActivateSessionRequest = z.output<typeof activateSessionRequestSchema>;
export type ChargerFaultProblem = z.output<typeof chargerFaultProblemSchema>;
export type AbortSessionRequest = z.output<typeof abortSessionRequestSchema>;
export type AbortSessionResponse = z.output<typeof abortSessionResponseSchema>;
export type StopSessionRequest = z.output<typeof stopSessionRequestSchema>;
export type StopSessionResponse = z.output<typeof stopSessionResponseSchema>;
export type ListStationSessionsQuery = z.output<typeof listStationSessionsQuerySchema>;
export type ChargerStatusView = z.output<typeof chargerStatusViewSchema>;
export type RecordTelemetryRequest = z.output<typeof recordTelemetryRequestSchema>;
export type TelemetryRecordView = z.output<typeof telemetryRecordViewSchema>;
