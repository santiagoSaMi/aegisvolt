import { unwrapResolverError } from '@apollo/server/errors';
import { getLogContext, type Logger } from '@aegisvolt/logger';
import type { GraphQLFormattedError } from 'graphql';

import {
  ConcurrentModificationError,
  DependencyUnavailableError,
  FeatureFlagNotFoundError,
  FeatureFlagVersionConflictError,
  ForbiddenError,
  NotFoundError,
  OperationConflictError,
  UnauthorizedError,
  UpstreamRejectedError,
  UpstreamUnavailableError,
} from '../../application/index.ts';
import { DomainError, InvalidValueError } from '../../domain/index.ts';
import { InputValidationError } from './validation.ts';

interface Mapped {
  readonly code: string;
  readonly message: string;
  readonly reason?: string;
  readonly fields?: readonly { path: string; message: string }[];
}

/** Errores conocidos → código GraphQL estable. Lo desconocido nunca se describe al cliente. */
function map(error: unknown): Mapped | undefined {
  if (error instanceof UnauthorizedError) {
    return { code: 'UNAUTHENTICATED', message: 'Se requiere autenticación' };
  }
  if (error instanceof ForbiddenError) {
    return { code: 'FORBIDDEN', message: error.message };
  }
  if (error instanceof InputValidationError) {
    return { code: 'BAD_USER_INPUT', message: error.message, fields: error.fields };
  }
  if (error instanceof InvalidValueError) {
    return {
      code: 'BAD_USER_INPUT',
      message: error.message,
      fields: [{ path: error.field, message: error.message }],
    };
  }
  if (error instanceof NotFoundError || error instanceof FeatureFlagNotFoundError) {
    return { code: 'NOT_FOUND', message: error.message };
  }
  if (error instanceof OperationConflictError) {
    return { code: 'CONFLICT', message: error.message, reason: error.reason };
  }
  if (error instanceof FeatureFlagVersionConflictError) {
    return { code: 'CONFLICT', message: error.message, reason: error.code };
  }
  if (error instanceof UpstreamRejectedError) {
    const code =
      error.status === 400
        ? 'BAD_USER_INPUT'
        : error.status === 404
          ? 'NOT_FOUND'
          : error.status === 401 || error.status === 403
            ? 'FORBIDDEN'
            : 'CONFLICT';
    return {
      code,
      // Los detalles 4xx de los servicios son mensajes de negocio (nunca internos).
      message: error.detail ?? `Operación rechazada: ${error.upstreamCode}`,
      reason: error.upstreamCode,
    };
  }
  if (
    error instanceof UpstreamUnavailableError ||
    error instanceof DependencyUnavailableError ||
    error instanceof ConcurrentModificationError
  ) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Servicio no disponible temporalmente; reintente',
    };
  }
  if (error instanceof DomainError) {
    return { code: 'BAD_USER_INPUT', message: error.message, reason: error.code };
  }
  return undefined;
}

/**
 * Manejo centralizado de errores (`formatError` de Apollo):
 * - errores de validación/sintaxis de GraphQL: se mantienen (sin stack);
 * - errores de los casos de uso: código estable + `reason` de negocio;
 * - cualquier otro: `INTERNAL_SERVER_ERROR` con mensaje genérico; el detalle
 *   (y el stack) solo va al log, con el `correlation_id`.
 * Siempre añade `extensions.correlationId` y nunca `stacktrace`.
 */
export function createErrorFormatter(logger: Logger) {
  return (formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
    const correlationId = getLogContext()?.correlationId;
    const original = unwrapResolverError(error);
    const base = {
      ...(formatted.locations === undefined ? {} : { locations: formatted.locations }),
      ...(formatted.path === undefined ? {} : { path: formatted.path }),
    };
    const known = map(original);
    if (known !== undefined) {
      if (known.code === 'SERVICE_UNAVAILABLE') {
        logger.warn('Dependencia no disponible', { error: describe(original) });
      }
      return {
        ...base,
        message: known.message,
        extensions: {
          code: known.code,
          ...(known.reason === undefined ? {} : { reason: known.reason }),
          ...(known.fields === undefined ? {} : { fields: known.fields }),
          ...(correlationId === undefined ? {} : { correlationId }),
        },
      };
    }
    // Errores propios de GraphQL (sintaxis, validación del documento, variables):
    // Apollo ya les asigna un código; a todo lo desconocido, INTERNAL_SERVER_ERROR.
    const code = formatted.extensions?.code;
    if (typeof code === 'string' && code !== 'INTERNAL_SERVER_ERROR') {
      return {
        ...base,
        message: formatted.message,
        extensions: { code, ...(correlationId === undefined ? {} : { correlationId }) },
      };
    }
    logger.error('Error no controlado en GraphQL', {
      error: describe(original),
      stack: original instanceof Error ? original.stack : undefined,
    });
    return {
      ...base,
      message: 'Error interno',
      extensions: {
        code: 'INTERNAL_SERVER_ERROR',
        ...(correlationId === undefined ? {} : { correlationId }),
      },
    };
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
