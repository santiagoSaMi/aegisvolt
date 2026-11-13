import type { NextFunction, Request, Response } from 'express';

import { correlationIdOf } from './correlation.ts';
import { buildProblem, sendProblem } from '../problem.ts';

/**
 * Presupuesto de tiempo por petición (ADR-0004). Si se agota, responde
 * 503 SERVICE_UNAVAILABLE (reintentable). Cualquier respuesta posterior del
 * handler se descarta porque ya se enviaron las cabeceras.
 */
export function requestTimeout(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      const correlationId = correlationIdOf(res);
      sendProblem(
        res,
        buildProblem({
          code: 'SERVICE_UNAVAILABLE',
          detail: `La petición superó el tiempo límite de ${timeoutMs} ms`,
          instance: req.originalUrl,
          ...(correlationId === undefined ? {} : { correlationId }),
        }),
      );
    }, timeoutMs);
    const clear = (): void => {
      clearTimeout(timer);
    };
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}
