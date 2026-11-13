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
  version: '1.1.0',
  basePath: '/v1',
} as const;

export const paths = {
  stations: () => `${API.basePath}/stations`,
  station: (stationId: string) => `${API.basePath}/stations/${encodeURIComponent(stationId)}`,
  availableConnectors: () => `${API.basePath}/connectors/available`,
  reservations: () => `${API.basePath}/reservations`,
  reservation: (reservationId: string) =>
    `${API.basePath}/reservations/${encodeURIComponent(reservationId)}`,
  confirmReservation: (reservationId: string) =>
    `${API.basePath}/reservations/${encodeURIComponent(reservationId)}/confirm`,
  releaseReservation: (reservationId: string) =>
    `${API.basePath}/reservations/${encodeURIComponent(reservationId)}/release`,
} as const;

// --- Vocabulario público ---------------------------------------------------

export const CONNECTOR_TYPES = ['CCS2', 'CHADEMO', 'TYPE2', 'GBT'] as const;
/**
 * AVAILABLE: libre · RESERVED: bloqueo temporal (vence) · OCCUPIED: carga en curso ·
 * OUT_OF_SERVICE: mantenimiento o avería. El estado es el **efectivo** en el
 * momento de la consulta (un RESERVED vencido se informa AVAILABLE).
 */
export const CONNECTOR_STATUSES = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE'] as const;
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

/** `GET /v1/stations?city=` (city obligatoria: la consulta usa el índice por ciudad, sin Scan). */
export const listStationsQuerySchema = z.strictObject({ city: citySchema });
export const listStationsResponseSchema = z.object({ items: z.array(stationViewSchema) });

/** `GET /v1/stations/{stationId}` → `stationViewSchema` */

/**
 * `PUT /v1/stations/{stationId}`: registra una estación con sus conectores (catálogo).
 * Idempotente: 201 creada · 200 ya existía idéntica · 409 STATION_ALREADY_EXISTS con
 * otros datos. Los conectores nacen AVAILABLE.
 */
export const registerStationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  city: citySchema,
  location: z.strictObject({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  connectors: z
    .array(
      z.strictObject({
        connectorId: connectorIdSchema,
        type: connectorTypeSchema,
        maxPowerKw: powerKwSchema,
      }),
    )
    .min(1)
    .max(20)
    .refine((items) => new Set(items.map((c) => c.connectorId)).size === items.length, {
      error: 'connectorId repetido',
    }),
});
export const registerStationResponseSchema = stationViewSchema;

/**
 * `GET /v1/connectors/available?city=` o `?stationId=` (exactamente uno):
 * conectores reservables ahora mismo.
 */
export const listAvailableConnectorsQuerySchema = z
  .strictObject({ city: citySchema.optional(), stationId: stationIdSchema.optional() })
  .refine((query) => (query.city === undefined) !== (query.stationId === undefined), {
    error: 'Indique exactamente uno de city o stationId',
  });
export const availableConnectorViewSchema = z.object({
  stationId: stationIdSchema,
  stationName: z.string(),
  city: citySchema,
  connector: connectorViewSchema,
});
export const listAvailableConnectorsResponseSchema = z.object({
  items: z.array(availableConnectorViewSchema),
});

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

/**
 * `POST /v1/reservations` con cabecera `idempotency-key` (UUID): misma operación
 * para clientes que no pre-generan el id. El id de la reserva se deriva de la clave
 * (`res_<idempotency-key>`), así que reutilizar la clave:
 * - con el mismo cuerpo → 200 con la reserva original;
 * - con otro cuerpo → 409 IDEMPOTENCY_CONFLICT.
 * Cabeceras: `idempotentCommandHeadersSchema`. Cuerpo: `holdReservationRequestSchema`.
 */
export const createReservationRequestSchema = holdReservationRequestSchema;

/** `GET /v1/reservations/{reservationId}` → `reservationViewSchema` (estado efectivo). */

/**
 * `POST /v1/reservations/{reservationId}/confirm` → 200 `reservationViewSchema` (CONFIRMED;
 * el conector pasa a OCCUPIED). `x-saga-id` debe ser la SAGA dueña (409 RESERVATION_MISMATCH).
 */
export const confirmReservationRequestSchema = z.strictObject({});
export const confirmReservationResponseSchema = reservationViewSchema;

/**
 * `POST /v1/reservations/{reservationId}/release` (compensación, idempotente):
 * - RELEASED: se liberó ahora · ALREADY_RELEASED: ya estaba liberada/vencida.
 * - VOIDED: no existía; se registró un tombstone que bloquea un `PUT` tardío.
 * - 409 RESERVATION_MISMATCH: `x-saga-id` no es la SAGA dueña de la reserva.
 * Nunca libera un conector bloqueado por otra reserva.
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
  RESERVATION_MISMATCH: 409,
  STATION_ALREADY_EXISTS: 409,
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
export type RegisterStationRequest = z.output<typeof registerStationRequestSchema>;
export type AvailableConnectorView = z.output<typeof availableConnectorViewSchema>;
