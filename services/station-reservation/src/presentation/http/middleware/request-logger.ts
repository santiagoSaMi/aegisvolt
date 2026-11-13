import type { Logger } from '@aegisvolt/logger';
import type { NextFunction, Request, Response } from 'express';

/** Una línea JSON por petición con método, ruta, status y duración. */
export function requestLogger(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        event: 'http_request',
        method: req.method,
        path: req.path,
        http_status: res.statusCode,
        duration_ms: Math.round(durationMs * 10) / 10,
      };
      if (res.statusCode >= 500) {
        logger.error('Petición HTTP fallida', fields);
      } else {
        logger.info('Petición HTTP', fields);
      }
    });
    next();
  };
}
