import { randomUUID } from 'node:crypto';

import { HTTP_HEADERS, correlationIdSchema, sagaIdSchema } from '@aegisvolt/contracts';
import { runWithLogContext } from '@aegisvolt/logger';
import type { NextFunction, Request, Response } from 'express';

/**
 * Propaga `correlation_id` (ADR-0009): reutiliza `x-correlation-id` si es un UUID
 * válido o genera uno. Lo devuelve en la respuesta y lo pone en el contexto de
 * logs junto con `saga_id` (si llega `x-saga-id`) para todo el procesamiento.
 */
export function correlation() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = correlationIdSchema.safeParse(req.get(HTTP_HEADERS.correlationId));
    const correlationId = incoming.success ? incoming.data : randomUUID();
    const saga = sagaIdSchema.safeParse(req.get(HTTP_HEADERS.sagaId));

    res.locals.correlationId = correlationId;
    res.setHeader(HTTP_HEADERS.correlationId, correlationId);
    runWithLogContext({ correlationId, ...(saga.success ? { sagaId: saga.data } : {}) }, () => {
      next();
    });
  };
}

export function correlationIdOf(res: Response): string | undefined {
  const value: unknown = res.locals.correlationId;
  return typeof value === 'string' ? value : undefined;
}
