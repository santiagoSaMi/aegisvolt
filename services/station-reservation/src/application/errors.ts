/**
 * Errores de aplicación (no son reglas de negocio): recursos inexistentes,
 * conflictos de concurrencia y dependencias no disponibles. Igual que los
 * errores de dominio, exponen un `code` estable del catálogo del contrato.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class StationNotFoundError extends ApplicationError {
  readonly code = 'STATION_NOT_FOUND';
}

export class ConnectorNotFoundError extends ApplicationError {
  readonly code = 'CONNECTOR_NOT_FOUND';
}

export class ReservationNotFoundError extends ApplicationError {
  readonly code = 'RESERVATION_NOT_FOUND';
}

export class StationAlreadyExistsError extends ApplicationError {
  readonly code = 'STATION_ALREADY_EXISTS';
}

/**
 * Otra escritura modificó los datos entre la lectura y la escritura condicional
 * (control de concurrencia optimista). Los casos de uso reintentan releyendo.
 */
export class ConcurrentModificationError extends ApplicationError {
  readonly code = 'CONCURRENT_MODIFICATION';
}

/** DynamoDB no respondió a tiempo o rechazó la petición por capacidad. */
export class DependencyUnavailableError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}
