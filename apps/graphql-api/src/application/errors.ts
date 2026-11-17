/**
 * Errores de aplicación del módulo de flags. Exponen un `code` del catálogo del
 * contrato featureFlagsV1 (que incluye los comunes UNAUTHORIZED/FORBIDDEN).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No hay identidad verificada (token ausente o inválido). */
export class UnauthorizedError extends ApplicationError {
  readonly code = 'UNAUTHORIZED';
}

/** La identidad no tiene el rol requerido (p. ej. escribir sin `platform-admins`). */
export class ForbiddenError extends ApplicationError {
  readonly code = 'FORBIDDEN';
}

/** La clave no está en el catálogo o no existe en la tabla del ambiente. */
export class FeatureFlagNotFoundError extends ApplicationError {
  readonly code = 'FEATURE_FLAG_NOT_FOUND';
}

/** `expectedVersion` no coincide: otro administrador cambió la flag. */
export class FeatureFlagVersionConflictError extends ApplicationError {
  readonly code = 'FEATURE_FLAG_VERSION_CONFLICT';
}

/** Escritura condicional rechazada (concurrencia optimista); el caso de uso reintenta. */
export class ConcurrentModificationError extends ApplicationError {
  readonly code = 'CONCURRENT_MODIFICATION';
}

/** El recurso pedido no existe (o no es visible para quien llama). */
export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

/**
 * La operación no es válida en el estado actual (regla del BFF), p. ej. liberar
 * una reserva cuya SAGA sigue en curso. `reason` es un código estable.
 */
export class OperationConflictError extends ApplicationError {
  readonly code = 'CONFLICT';
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Un servicio rechazó la petición (4xx). Se conserva su status y su `code`
 * (catálogo de su contrato) para que el cliente sepa por qué, sin detalles internos.
 */
export class UpstreamRejectedError extends ApplicationError {
  readonly code = 'UPSTREAM_REJECTED';
  readonly service: string;
  readonly status: number;
  readonly upstreamCode: string;
  readonly detail: string | undefined;

  constructor(input: { service: string; status: number; upstreamCode: string; detail?: string }) {
    super(`${input.service} rechazó la petición: ${input.upstreamCode}`);
    this.service = input.service;
    this.status = input.status;
    this.upstreamCode = input.upstreamCode;
    this.detail = input.detail;
  }
}

/** Un servicio no respondió a tiempo o falló (tras los reintentos permitidos). */
export class UpstreamUnavailableError extends ApplicationError {
  readonly code = 'UPSTREAM_UNAVAILABLE';
  readonly service: string;

  constructor(service: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.service = service;
  }
}

/** DynamoDB no respondió o rechazó la petición por capacidad. */
export class DependencyUnavailableError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}
