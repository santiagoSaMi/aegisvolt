/**
 * Errores de aplicación (no son reglas de negocio): recursos inexistentes,
 * conflictos de concurrencia y dependencias no disponibles. Exponen un `code`
 * del catálogo del contrato energy-dispatch v1.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SessionNotFoundError extends ApplicationError {
  readonly code = 'SESSION_NOT_FOUND';
}

/** Cursor de paginación ilegible o manipulado. */
export class InvalidCursorError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';
}

/**
 * Otra escritura cambió los datos entre la lectura y la escritura condicional
 * (concurrencia optimista). Los casos de uso releen y reintentan.
 */
export class ConcurrentModificationError extends ApplicationError {
  readonly code = 'CONCURRENT_MODIFICATION';
}

/** DynamoDB no respondió a tiempo o rechazó la petición por capacidad. */
export class DependencyUnavailableError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}

/**
 * Fallo TÉCNICO al hablar con el cargador (sin comunicación, timeout, respuesta
 * ilegible). Es reintentable (503) y NO es una falla física: el resultado de la
 * activación es desconocido y el orquestador debe consultar la sesión antes de
 * compensar. Una falla física es un resultado (`ChargerActivationResult.FAULT`, 422).
 */
export class ChargerUnavailableError extends ApplicationError {
  readonly code = 'CHARGER_UNAVAILABLE';
}
