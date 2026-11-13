/**
 * Errores de aplicación (no son reglas de negocio): recursos inexistentes,
 * conflictos de concurrencia, dependencias no disponibles. Exponen un `code`
 * del catálogo del contrato billing-wallet v1.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class DebitNotFoundError extends ApplicationError {
  readonly code = 'DEBIT_NOT_FOUND';
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
