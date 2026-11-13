import { setTimeout as delay } from 'node:timers/promises';

import {
  HTTP_HEADERS,
  idempotentCommandHeadersSchema,
  sagaIdSchema,
  sagaOrchestratorV1 as api,
} from '@aegisvolt/contracts';
import type { Logger } from '@aegisvolt/logger';
import { Router, type Response } from 'express';
import { z } from 'zod';

import type {
  GetSaga,
  ListFleetSagas,
  ListSagaEvents,
  ReserveAndActivateCharging,
  RetryCompensation,
} from '../../../application/index.ts';
import type { SagaTransaction } from '../../../domain/index.ts';
import { correlationIdOf } from '../middleware/correlation.ts';
import { sendJson } from '../problem.ts';
import { parseRequest } from '../validation.ts';
import { toEventView, toSagaView } from '../views.ts';

export interface SagaUseCases {
  readonly reserveAndActivateCharging: ReserveAndActivateCharging;
  readonly retryCompensation: RetryCompensation;
  readonly getSaga: GetSaga;
  readonly listSagaEvents: ListSagaEvents;
  readonly listFleetSagas: ListFleetSagas;
}

const base = api.API.basePath;
const ROUTES = {
  sagas: `${base}/sagas`,
  saga: `${base}/sagas/:sagaId`,
  sagaEvents: `${base}/sagas/:sagaId/events`,
  retryCompensation: `${base}/sagas/:sagaId/compensation/retry`,
} as const;

const sagaParamsSchema = z.object({ sagaId: sagaIdSchema });

const TIMED_OUT = Symbol('timed-out');

/**
 * Espera a la SAGA como máximo `waitMs`. Si no terminó, la deja corriendo (tiene
 * su *lease* y su recuperación) y responde con el estado persistido (202).
 */
async function within<T>(
  work: Promise<T>,
  waitMs: number,
  logger: Logger,
): Promise<T | typeof TIMED_OUT> {
  const guarded = work.catch((error: unknown) => {
    logger.error('La SAGA falló en segundo plano', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    throw error;
  });
  const timer = new AbortController();
  try {
    return await Promise.race([guarded, delay(waitMs, TIMED_OUT, { signal: timer.signal })]);
  } finally {
    timer.abort();
    guarded.catch(() => undefined);
  }
}

function sendSaga(res: Response, saga: SagaTransaction, terminalStatus: number): void {
  res.setHeader('location', api.paths.saga(saga.id));
  sendJson(res, saga.isTerminal ? terminalStatus : 202, toSagaView(saga));
}

/**
 * Controllers delgados: validan con el contrato y delegan en los casos de uso.
 * No contienen lógica de la SAGA.
 */
export function sagaRoutes(
  useCases: SagaUseCases,
  options: { syncWaitMs: number; logger: Logger },
) {
  const router = Router();

  router.post(ROUTES.sagas, async (req, res) => {
    const headers = parseRequest(idempotentCommandHeadersSchema, req.headers, 'headers');
    const body = parseRequest(api.startSagaRequestSchema, req.body, 'body');
    const idempotencyKey = headers[HTTP_HEADERS.idempotencyKey];
    const result = await within(
      useCases.reserveAndActivateCharging.execute({
        ...body,
        idempotencyKey,
        correlationId: correlationIdOf(res) ?? headers[HTTP_HEADERS.correlationId],
      }),
      options.syncWaitMs,
      options.logger,
    );
    const saga =
      result === TIMED_OUT
        ? await useCases.getSaga.execute(`saga_${idempotencyKey.toLowerCase()}`)
        : result.saga;
    sendSaga(res, saga, 201);
  });

  router.get(ROUTES.saga, async (req, res) => {
    const { sagaId } = parseRequest(sagaParamsSchema, req.params, 'params');
    sendJson(res, 200, toSagaView(await useCases.getSaga.execute(sagaId)));
  });

  router.get(ROUTES.sagaEvents, async (req, res) => {
    const { sagaId } = parseRequest(sagaParamsSchema, req.params, 'params');
    const { saga, events } = await useCases.listSagaEvents.execute(sagaId);
    sendJson(res, 200, { items: events.map((event) => toEventView(saga, event)) });
  });

  router.get(ROUTES.sagas, async (req, res) => {
    const query = parseRequest(api.listSagasQuerySchema, req.query, 'query');
    const sagas = await useCases.listFleetSagas.execute(query);
    sendJson(res, 200, { items: sagas.map(toSagaView) });
  });

  /** Reintento CONTROLADO de una compensación fallida. */
  router.post(ROUTES.retryCompensation, async (req, res) => {
    const { sagaId } = parseRequest(sagaParamsSchema, req.params, 'params');
    const result = await within(
      useCases.retryCompensation.execute(sagaId),
      options.syncWaitMs,
      options.logger,
    );
    const saga = result === TIMED_OUT ? await useCases.getSaga.execute(sagaId) : result;
    sendSaga(res, saga, 200);
  });

  return router;
}
