import {
  HTTP_HEADERS,
  billingWalletV1 as api,
  debitIdSchema,
  idempotencyKeySchema,
  idempotentCommandHeadersSchema,
  sagaCommandHeadersSchema,
} from '@aegisvolt/contracts';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type {
  DebitWallet,
  DebitWalletResult,
  GetDebit,
  RefundWallet,
} from '../../../application/index.ts';
import { DebitVoidedError } from '../../../domain/index.ts';
import { correlationIdOf } from '../middleware/correlation.ts';
import { sendJson } from '../problem.ts';
import { RequestValidationError, parseRequest } from '../validation.ts';
import { toDebitView } from '../views.ts';
import { ROUTES } from './route-patterns.ts';

export interface DebitUseCases {
  readonly debitWallet: DebitWallet;
  readonly refundWallet: RefundWallet;
  readonly getDebit: GetDebit;
}

const debitParamsSchema = z.object({ debitId: debitIdSchema });
const optionalIdempotencyKeySchema = z.object({
  [HTTP_HEADERS.idempotencyKey]: idempotencyKeySchema.optional(),
});

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

/** `correlation_id` de la petición (lo fija siempre el middleware de correlación). */
function correlationOf(res: Response): string {
  return correlationIdOf(res) ?? '';
}

const statusFor = (result: DebitWalletResult): number => (result.outcome === 'DEBITED' ? 201 : 200);

/** Controllers delgados: validan con el contrato, delegan y mapean la respuesta. */
export function debitRoutes(useCases: DebitUseCases): Router {
  const router = Router();

  /** Débito con id pre-generado por la SAGA: el id es la clave idempotente. */
  router.put(ROUTES.debit, async (req, res) => {
    const { debitId } = parseRequest(debitParamsSchema, req.params, 'params');
    const body = parseRequest(api.debitRequestSchema, req.body, 'body');
    sagaHeaders(req, body.sagaId);
    const result = await useCases.debitWallet.execute({
      debitId,
      ...body,
      audit: { correlationId: correlationOf(res), idempotencyKey: debitId },
    });
    sendJson(res, statusFor(result), toDebitView(result.debit));
  });

  /** Débito con cabecera `idempotency-key`: el id se deriva de la clave (`dbt_<clave>`). */
  router.post(ROUTES.debits, async (req, res) => {
    const headers = parseRequest(idempotentCommandHeadersSchema, req.headers, 'headers');
    const body = parseRequest(api.createDebitRequestSchema, req.body, 'body');
    const idempotencyKey = headers[HTTP_HEADERS.idempotencyKey];
    const debitId = `dbt_${idempotencyKey}`;
    const result = await useCases.debitWallet.execute({
      debitId,
      ...body,
      audit: { correlationId: correlationOf(res), idempotencyKey },
    });
    res.setHeader('location', api.paths.debit(debitId));
    sendJson(res, statusFor(result), toDebitView(result.debit));
  });

  router.get(ROUTES.debit, async (req, res) => {
    const { debitId } = parseRequest(debitParamsSchema, req.params, 'params');
    const stored = await useCases.getDebit.execute(debitId);
    if (stored.kind === 'TOMBSTONE') {
      throw new DebitVoidedError(`El débito ${debitId} fue anulado por una compensación`);
    }
    sendJson(res, 200, toDebitView(stored.debit));
  });

  /** Compensación: reembolso como operación propia (idempotente). */
  router.post(ROUTES.refundDebit, async (req, res) => {
    const { debitId } = parseRequest(debitParamsSchema, req.params, 'params');
    const { reason } = parseRequest(api.refundDebitRequestSchema, req.body, 'body');
    const headers = sagaHeaders(req);
    const optional = parseRequest(optionalIdempotencyKeySchema, req.headers, 'headers');
    const idempotencyKey = optional[HTTP_HEADERS.idempotencyKey];
    const result = await useCases.refundWallet.execute({
      debitId,
      sagaId: headers[HTTP_HEADERS.sagaId],
      reason,
      audit: {
        correlationId: correlationOf(res),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    });
    sendJson(
      res,
      200,
      result.outcome === 'VOIDED'
        ? { debitId, status: 'VOIDED', outcome: 'VOIDED' }
        : {
            debitId,
            status: result.debit.status,
            outcome: result.outcome,
            ...(result.refundId === undefined ? {} : { refundId: result.refundId }),
          },
    );
  });

  return router;
}
