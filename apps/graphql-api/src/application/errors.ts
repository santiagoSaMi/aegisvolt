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

/** DynamoDB no respondió o rechazó la petición por capacidad. */
export class DependencyUnavailableError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}
