/**
 * Contrato público de station-reservation-service, versión 1.
 * Proveedor: station-reservation-service. Consumidores: saga-orchestrator-service
 * (comandos de la SAGA) y graphql-api (lecturas).
 */
import { z } from 'zod';

import {
  connectorIdSchema,
  fleetIdSchema,
  reservationIdSchema,
  sagaIdSchema,
  stationIdSchema,
} from '../common/identifiers.ts';
import {
  citySchema,
  compensationReasonSchema,
  isoDateTimeSchema,
  powerKwSchema,
} from '../common/primitives.ts';
import { COMMON_ERROR_CODES, problemSchemaFor } from '../problem-details.ts';

export const API = {
  name: 'station-reservation',
  version: '1.0.0',
  basePath: '/v1',
} as const;

export const paths = {
  stations: () => `${API.basePath}/stations`,
  station: (stationId: string) => `${API.basePath}/stations/${encodeURIComponent(stationId)}`,
  reservation: (reservationId: string) =>
    `${API.basePath}/reservations/${encodeURIComponent(reservationId)}`,
  confirmReservation: (reservationId: string) =>
    `${API.basePath}/reservations/${encodeURIComponent(reservationId)}/confirm`,
  releaseReservation: (reservationId: string) =>
    `${API.basePath}/reservations/${encodeURIComponent(reservationId)}/release`,
} as const;

// --- Vocabulario público ---------------------------------------------------

export const CONNECTOR_TYPES = ['CCS2', 'CHADEMO', 'TYPE2', 'GBT'] as const;
export const CONNECTOR_STATUSES = ['AVAILABLE', 'RESERVED', 'OUT_OF_SERVICE'] as const;
export const RESERVATION_STATUSES = ['HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'VOIDED'] as const;
export const RELEASE_OUTCOMES = ['RELEASED', 'ALREADY_RELEASED', 'VOIDED'] as const;

export const connectorTypeSchema = z.enum(CONNECTOR_TYPES);
export const connectorStatusSchema = z.enum(CONNECTOR_STATUSES);
export const reservationStatusSchema = z.enum(RESERVATION_STATUSES);

// --- Lecturas ------------------------------------------------------------

export const connectorViewSchema = z.object({
  connectorId: connectorIdSchema,
  type: connectorTypeSchema,
  maxPowerKw: powerKwSchema,
  ultraFast: z.boolean(),
  status: connectorStatusSchema,
  /** Disponible para reservar ahora (incluye *holds* vencidos). */
  availableForReservation: z.boolean(),
});

export const stationViewSchema = z.object({
  stationId: stationIdSchema,
  name: z.string().min(1).max(120),
  city: citySchema,
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  connectors: z.array(connectorViewSchema),
});

/** `GET /v1/stations?city=` */
export const listStationsQuerySchema = z.strictObject({ city: citySchema.optional() });
export const listStationsResponseSchema = z.object({ items: z.array(stationViewSchema) });

/** `GET /v1/stations/{stationId}` → `stationViewSchema` */

// --- Comandos de la SAGA ---------------------------------------------------

export const reservationViewSchema = z.object({
  reservationId: reservationIdSchema,
  sagaId: sagaIdSchema,
  fleetId: fleetIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  status: reservationStatusSchema,
  fastChargeBoost: z.boolean(),
  holdExpiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * `PUT /v1/reservations/{reservationId}`: bloqueo temporal (*hold*) del conector.
 * Idempotente por `reservationId` (pre-generado por el orquestador, ADR-0005):
 * - 201: creado · 200: repetición con el mismo payload (misma respuesta).
 * - 409 IDEMPOTENCY_CONFLICT: mismo id con payload distinto.
 * - 409 RESERVATION_CANCELLED: el id tiene un tombstone (se compensó antes).
 * La duración del *hold* la decide el servicio (política de reserva), no el cliente.
 * Cabeceras: `sagaCommandHeadersSchema`.
 */
export const holdReservationRequestSchema = z.strictObject({
  sagaId: sagaIdSchema,
  fleetId: fleetIdSchema,
  stationId: stationIdSchema,
  connectorId: connectorIdSchema,
  fastChargeBoost: z.boolean(),
});
export const holdReservationResponseSchema = reservationViewSchema;

/** `POST /v1/reservations/{reservationId}/confirm` → 200 `reservationViewSchema` (CONFIRMED). */
export const confirmReservationRequestSchema = z.strictObject({});
export const confirmReservationResponseSchema = reservationViewSchema;

/**
 * `POST /v1/reservations/{reservationId}/release` (compensación, idempotente):
 * - RELEASED: se liberó ahora · ALREADY_RELEASED: ya estaba liberada/vencida.
 * - VOIDED: no existía; se registró un tombstone que bloquea un `PUT` tardío.
 */
export const releaseReservationRequestSchema = z.strictObject({
  reason: compensationReasonSchema,
});
export const releaseReservationResponseSchema = z.object({
  reservationId: reservationIdSchema,
  status: reservationStatusSchema,
  outcome: z.enum(RELEASE_OUTCOMES),
});

// --- Errores ---------------------------------------------------------------

export const ERROR_CODES = {
  ...COMMON_ERROR_CODES,
  STATION_NOT_FOUND: 404,
  CONNECTOR_NOT_FOUND: 404,
  RESERVATION_NOT_FOUND: 404,
  FAST_CHARGE_BOOST_DISABLED: 403,
  CONNECTOR_UNAVAILABLE: 409,
  ULTRA_FAST_REQUIRES_BOOST: 409,
  RESERVATION_CANCELLED: 409,
  RESERVATION_NOT_HELD: 409,
  RESERVATION_HOLD_EXPIRED: 409,
  IDEMPOTENCY_CONFLICT: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

// --- Tipos -------------------------------------------------------------------

export type ConnectorView = z.output<typeof connectorViewSchema>;
export type StationView = z.output<typeof stationViewSchema>;
export type ReservationView = z.output<typeof reservationViewSchema>;
export type HoldReservationRequest = z.output<typeof holdReservationRequestSchema>;
export type ReleaseReservationRequest = z.output<typeof releaseReservationRequestSchema>;
export type ReleaseReservationResponse = z.output<typeof releaseReservationResponseSchema>;
