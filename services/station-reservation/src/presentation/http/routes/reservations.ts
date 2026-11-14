import {
  HTTP_HEADERS,
  idempotentCommandHeadersSchema,
  reservationIdSchema,
  sagaCommandHeadersSchema,
  stationReservationV1 as api,
} from '@aegisvolt/contracts';
import { Router, type Request } from 'express';
import { z } from 'zod';

import type {
  ConfirmReservation,
  CreateReservation,
  CreateReservationResult,
  GetReservation,
  ListFleetReservations,
  ReleaseReservation,
} from '../../../application/index.ts';
import { sendJson } from '../problem.ts';
import { ROUTES } from './route-patterns.ts';
import { RequestValidationError, parseRequest } from '../validation.ts';
import { toReservationView } from '../views.ts';

export interface ReservationUseCases {
  readonly createReservation: CreateReservation;
  readonly confirmReservation: ConfirmReservation;
  readonly releaseReservation: ReleaseReservation;
  readonly getReservation: GetReservation;
  readonly listFleetReservations: ListFleetReservations;
}

const reservationParamsSchema = z.object({ reservationId: reservationIdSchema });

/** Cabeceras de un comando de la SAGA; `x-saga-id` debe coincidir con el `sagaId` del cuerpo. */
function sagaHeaders(req: Request, bodySagaId?: string) {
  const headers = parseRequest(sagaCommandHeadersSchema, req.headers, 'headers');
  if (bodySagaId !== undefined && headers[HTTP_HEADERS.sagaId] !== bodySagaId) {
    throw new RequestValidationError([
      { path: `headers.${HTTP_HEADERS.sagaId}`, message: 'Debe coincidir con body.sagaId' },
    ]);
  }
  return headers;
}

function statusFor(result: CreateReservationResult): number {
  return result.outcome === 'CREATED' ? 201 : 200;
}

/** Controllers delgados: validan con el contrato, delegan y mapean la respuesta. */
export function reservationRoutes(useCases: ReservationUseCases): Router {
  const router = Router();

  /** Reserva con id pre-generado por el cliente (la SAGA): el id es la clave de idempotencia. */
  router.put(ROUTES.reservation, async (req, res) => {
    const { reservationId } = parseRequest(reservationParamsSchema, req.params, 'params');
    const body = parseRequest(api.holdReservationRequestSchema, req.body, 'body');
    sagaHeaders(req, body.sagaId);
    const result = await useCases.createReservation.execute({ reservationId, ...body });
    sendJson(res, statusFor(result), toReservationView(result.reservation, result.now));
  });

  /** Reserva con cabecera `idempotency-key`: el id se deriva de la clave (`res_<clave>`). */
  router.post(ROUTES.reservations, async (req, res) => {
    const headers = parseRequest(idempotentCommandHeadersSchema, req.headers, 'headers');
    const body = parseRequest(api.createReservationRequestSchema, req.body, 'body');
    const reservationId = `res_${headers[HTTP_HEADERS.idempotencyKey]}`;
    const result = await useCases.createReservation.execute({ reservationId, ...body });
    res.setHeader('location', api.paths.reservation(reservationId));
    sendJson(res, statusFor(result), toReservationView(result.reservation, result.now));
  });

  /** Reservas de una flota (desde 1.2.0), la más reciente primero. */
  router.get(ROUTES.reservations, async (req, res) => {
    const query = parseRequest(api.listReservationsQuerySchema, req.query, 'query');
    const page = await useCases.listFleetReservations.execute(query);
    sendJson(res, 200, {
      items: page.items.map((reservation) => toReservationView(reservation, page.now)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  router.get(ROUTES.reservation, async (req, res) => {
    const { reservationId } = parseRequest(reservationParamsSchema, req.params, 'params');
    const { reservation, now } = await useCases.getReservation.execute(reservationId);
    sendJson(res, 200, toReservationView(reservation, now));
  });

  router.post(ROUTES.confirmReservation, async (req, res) => {
    const { reservationId } = parseRequest(reservationParamsSchema, req.params, 'params');
    parseRequest(api.confirmReservationRequestSchema, req.body ?? {}, 'body');
    const headers = sagaHeaders(req);
    const { reservation, now } = await useCases.confirmReservation.execute({
      reservationId,
      sagaId: headers[HTTP_HEADERS.sagaId],
    });
    sendJson(res, 200, toReservationView(reservation, now));
  });

  router.post(ROUTES.releaseReservation, async (req, res) => {
    const { reservationId } = parseRequest(reservationParamsSchema, req.params, 'params');
    const { reason } = parseRequest(api.releaseReservationRequestSchema, req.body, 'body');
    const headers = sagaHeaders(req);
    const result = await useCases.releaseReservation.execute({
      reservationId,
      sagaId: headers[HTTP_HEADERS.sagaId],
      reason,
    });
    sendJson(res, 200, {
      reservationId,
      status: result.outcome === 'VOIDED' ? 'VOIDED' : result.reservation.status,
      outcome: result.outcome,
    });
  });

  return router;
}
