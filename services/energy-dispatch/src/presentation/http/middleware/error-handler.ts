import type { ProblemDetails } from '@aegisvolt/contracts';
import type { Logger } from '@aegisvolt/logger';
import type { NextFunction, Request, Response } from 'express';

import { ApplicationError } from '../../../application/index.ts';
import { DomainError, InvalidValueError } from '../../../domain/index.ts';
import { buildProblem, isKnownErrorCode, sendProblem } from '../problem.ts';
import { RequestValidationError } from '../validation.ts';
import { correlationIdOf } from './correlation.ts';

interface BodyParserError {
  type?: unknown;
}

/**
 * Manejo centralizado de errores → problem+json (RFC 9457) con el catálogo del
 * contrato. Nunca expone stack traces ni mensajes internos en errores 5xx.
 */
export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      // Ya se respondió (p. ej. por timeout): solo se registra.
      logger.warn('Error tras enviar la respuesta', { error: describe(error) });
      next(error);
      return;
    }
    const correlationId = correlationIdOf(res);
    const problem = toProblem(error, req.originalUrl, correlationId);
    if (problem.status >= 500) {
      logger.error('Error no controlado', {
        error: describe(error),
        stack: error instanceof Error ? error.stack : undefined,
        code: problem.code,
      });
    }
    sendProblem(res, problem);
  };
}

function toProblem(error: unknown, instance: string, correlationId?: string): ProblemDetails {
  const base = { instance, ...(correlationId === undefined ? {} : { correlationId }) };

  if (error instanceof RequestValidationError) {
    return buildProblem({ ...base, code: 'VALIDATION_ERROR', errors: error.errors });
  }
  if (isBodyParserError(error)) {
    return buildProblem({
      ...base,
      code: 'VALIDATION_ERROR',
      detail: 'El cuerpo no es JSON válido',
    });
  }
  if (error instanceof InvalidValueError) {
    return buildProblem({
      ...base,
      code: 'VALIDATION_ERROR',
      errors: [{ path: error.field, message: error.message }],
    });
  }
  if (error instanceof DomainError || error instanceof ApplicationError) {
    if (error.code === 'CONCURRENT_MODIFICATION') {
      return buildProblem({
        ...base,
        code: 'SERVICE_UNAVAILABLE',
        detail: 'Conflicto de concurrencia persistente; reintente',
      });
    }
    if (isKnownErrorCode(error.code)) {
      const status = buildProblem({ code: error.code }).status;
      return buildProblem({
        ...base,
        code: error.code,
        // Los mensajes de dominio son seguros; los de dependencias 5xx no se exponen.
        ...(status < 500 ? { detail: error.message } : {}),
      });
    }
  }
  return buildProblem({ ...base, code: 'INTERNAL_ERROR', detail: 'Error interno' });
}

function isBodyParserError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { type } = error as BodyParserError;
  return type === 'entity.parse.failed' || type === 'entity.too.large';
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
