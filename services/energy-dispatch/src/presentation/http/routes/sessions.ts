import {
  HTTP_HEADERS,
  energyDispatchV1 as api,
  sagaCommandHeadersSchema,
  sessionIdSchema,
} from '@aegisvolt/contracts';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type {
  AbortChargingSession,
  GetChargingSession,
  ListSessionTelemetry,
  RecordTelemetry,
  StartChargingSession,
  StopChargingSession,
} from '../../../application/index.ts';
import type { ChargingSession } from '../../../domain/index.ts';
import { correlationIdOf } from '../middleware/correlation.ts';
import { buildProblem, sendJson, sendProblem } from '../problem.ts';
import { RequestValidationError, parseRequest } from '../validation.ts';
import { toSessionView, toTelemetryView } from '../views.ts';
import { ROUTES } from './route-patterns.ts';

export interface SessionUseCases {
  readonly startChargingSession: StartChargingSession;
  readonly stopChargingSession: StopChargingSession;
  readonly abortChargingSession: AbortChargingSession;
  readonly recordTelemetry: RecordTelemetry;
  readonly getChargingSession: GetChargingSession;
  readonly listSessionTelemetry: ListSessionTelemetry;
}

const sessionParamsSchema = z.object({ sessionId: sessionIdSchema });

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

/**
 * Sesión FAILED → 422 CHARGER_HARDWARE_FAULT con el código de falla y si fue
 * simulada: el orquestador lo trata como falla definitiva y compensa.
 */
function sendChargerFault(res: Response, req: Request, session: ChargingSession): void {
  const correlationId = correlationIdOf(res);
  const { fault } = session;
  if (fault === undefined) {
    throw new Error(`Invariante rota: la sesión ${session.id} está FAILED sin falla`);
  }
  const problem: z.input<typeof api.chargerFaultProblemSchema> = {
    ...buildProblem({
      code: 'CHARGER_HARDWARE_FAULT',
      detail: `El cargador reportó la falla ${fault.code}${fault.simulated ? ' (simulada)' : ''}`,
      instance: req.originalUrl,
      ...(correlationId === undefined ? {} : { correlationId }),
    }),
    code: 'CHARGER_HARDWARE_FAULT',
    status: 422,
    faultCode: fault.code,
    simulated: fault.simulated,
    sessionId: session.id,
  };
  sendProblem(res, problem);
}

/** Controllers delgados: validan con el contrato, delegan y mapean la respuesta. */
export function sessionRoutes(useCases: SessionUseCases): Router {
  const router = Router();

  /** Paso 3 de la SAGA: id pre-generado por el orquestador (clave idempotente). */
  router.put(ROUTES.session, async (req, res) => {
    const { sessionId } = parseRequest(sessionParamsSchema, req.params, 'params');
    const body = parseRequest(api.activateSessionRequestSchema, req.body, 'body');
    sagaHeaders(req, body.sagaId);
    const result = await useCases.startChargingSession.execute({ sessionId, ...body });
    if (result.session.status === 'FAILED') {
      sendChargerFault(res, req, result.session);
      return;
    }
    sendJson(res, result.kind === 'STARTED' ? 201 : 200, toSessionView(result.session));
  });

  router.get(ROUTES.session, async (req, res) => {
    const { sessionId } = parseRequest(sessionParamsSchema, req.params, 'params');
    sendJson(res, 200, toSessionView(await useCases.getChargingSession.execute(sessionId)));
  });

  /** Parada normal (usuario u operador), idempotente. */
  router.post(ROUTES.stopSession, async (req, res) => {
    const { sessionId } = parseRequest(sessionParamsSchema, req.params, 'params');
    const { reason } = parseRequest(api.stopSessionRequestSchema, req.body ?? {}, 'body');
    const result = await useCases.stopChargingSession.execute({ sessionId, reason });
    sendJson(res, 200, { sessionId, status: result.session.status, outcome: result.outcome });
  });

  /** Compensación de la SAGA, idempotente. */
  router.post(ROUTES.abortSession, async (req, res) => {
    const { sessionId } = parseRequest(sessionParamsSchema, req.params, 'params');
    parseRequest(api.abortSessionRequestSchema, req.body, 'body');
    sagaHeaders(req);
    const result = await useCases.abortChargingSession.execute({ sessionId });
    sendJson(res, 200, {
      sessionId,
      status: result.outcome === 'VOIDED' ? 'VOIDED' : result.session.status,
      outcome: result.outcome,
    });
  });

  /** Lectura del cargador (idempotente por `timestamp`). */
  router.post(ROUTES.sessionTelemetry, async (req, res) => {
    const { sessionId } = parseRequest(sessionParamsSchema, req.params, 'params');
    const { timestamp, temperatureC, ...measures } = parseRequest(
      api.recordTelemetryRequestSchema,
      req.body,
      'body',
    );
    const result = await useCases.recordTelemetry.execute({
      sessionId,
      reading: {
        ...measures,
        timestamp: new Date(timestamp),
        ...(temperatureC === undefined ? {} : { temperatureC }),
      },
    });
    sendJson(res, result.outcome === 'RECORDED' ? 201 : 200, toTelemetryView(result.record));
  });

  router.get(ROUTES.sessionTelemetry, async (req, res) => {
    const { sessionId } = parseRequest(sessionParamsSchema, req.params, 'params');
    const { limit } = parseRequest(api.listTelemetryQuerySchema, req.query, 'query');
    const items = await useCases.listSessionTelemetry.execute({ sessionId, limit });
    sendJson(res, 200, { items: items.map(toTelemetryView) });
  });

  return router;
}
