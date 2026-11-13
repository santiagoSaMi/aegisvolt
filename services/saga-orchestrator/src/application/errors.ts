/**
 * Errores de aplicación del orquestador. Exponen un `code` del catálogo del
 * contrato saga-orchestrator v1.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SagaNotFoundError extends ApplicationError {
  readonly code = 'SAGA_NOT_FOUND';
}

/** Otra réplica tiene el *lease* de la SAGA y la está ejecutando. */
export class SagaBusyError extends ApplicationError {
  readonly code = 'SAGA_BUSY';
}

/**
 * Una escritura condicional falló: otra réplica cambió la SAGA (versión) o le
 * quitó el *lease*. Quien la recibe deja de ejecutar la SAGA: nunca la avanzan dos.
 */
export class ConcurrentModificationError extends ApplicationError {
  readonly code = 'CONCURRENT_MODIFICATION';
}

/** La SAGA ya existe (creación concurrente con la misma clave idempotente). */
export class SagaAlreadyExistsError extends ApplicationError {
  readonly code = 'CONCURRENT_MODIFICATION';
}

/** DynamoDB no respondió a tiempo o rechazó la petición por capacidad. */
export class DependencyUnavailableError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}
