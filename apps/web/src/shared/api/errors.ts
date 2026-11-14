import { CombinedGraphQLErrors, ServerError } from '@apollo/client/errors';

/** Error listo para mostrar: mensaje, código estable y correlation_id para soporte. */
export interface UiError {
  readonly message: string;
  readonly code: string | undefined;
  readonly reason: string | undefined;
  readonly correlationId: string | undefined;
}

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Su sesión no es válida o venció. Vuelva a iniciar sesión.',
  FORBIDDEN: 'No tiene permiso para esta operación.',
  SERVICE_UNAVAILABLE: 'Un servicio no está disponible en este momento. Intente de nuevo.',
  INTERNAL_SERVER_ERROR: 'Ocurrió un error inesperado.',
};

/** Traduce un error de Apollo a un `UiError` (sin detalles técnicos internos). */
export function toUiError(error: unknown): UiError {
  if (CombinedGraphQLErrors.is(error)) {
    const first = error.errors[0];
    const extensions = (first?.extensions ?? {}) as Record<string, unknown>;
    const code = typeof extensions.code === 'string' ? extensions.code : undefined;
    const reason = typeof extensions.reason === 'string' ? extensions.reason : undefined;
    const message =
      code !== undefined && code in MESSAGES ? (MESSAGES[code] ?? '') : (first?.message ?? 'Error');
    return {
      message,
      code,
      reason,
      correlationId:
        typeof extensions.correlationId === 'string' ? extensions.correlationId : undefined,
    };
  }
  if (ServerError.is(error)) {
    return {
      message: 'El servidor respondió con un error. Intente de nuevo.',
      code: `HTTP_${String(error.statusCode)}`,
      reason: undefined,
      correlationId: undefined,
    };
  }
  return {
    message: 'No se pudo conectar con el servidor.',
    code: 'NETWORK_ERROR',
    reason: undefined,
    correlationId: undefined,
  };
}
