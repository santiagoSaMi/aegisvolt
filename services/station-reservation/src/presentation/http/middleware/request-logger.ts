import { getLogContext, runWithLogContext, type Logger } from '@aegisvolt/logger';
import type { NextFunction, Request, Response } from 'express';

/**
 * Una línea JSON por petición con método, ruta, status y duración, emitida en
 * el contexto de la petición: `correlation_id`, `saga_id` y la `operation` que
 * fijó la ruta. Si ninguna ruta la nombró (p. ej. 404), `operation` es
 * `MÉTODO /ruta`. Nunca registra cabeceras, query string ni cuerpo.
 */
export function requestLogger(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    // Mismo objeto de contexto que luego nombra la ruta (setLogOperation).
    const context = getLogContext();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        event: 'http_request',
        method: req.method,
        path: req.path,
        http_status: res.statusCode,
        duration_ms: Math.round(durationMs * 10) / 10,
        ...(context?.operation === undefined ? { operation: `${req.method} ${req.path}` } : {}),
      };
      const emit = (): void => {
        if (res.statusCode >= 500) {
          logger.error('Petición HTTP fallida', fields);
        } else {
          logger.info('Petición HTTP', fields);
        }
      };
      if (context === undefined) {
        emit();
      } else {
        runWithLogContext(context, emit);
      }
    });
    next();
  };
}
