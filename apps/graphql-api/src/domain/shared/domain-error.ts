/**
 * Base de los errores de dominio de Platform Configuration (graphql-api). Cada error tiene un `code`
 * estable; la capa HTTP lo traduce al catálogo del contrato público.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Un valor no cumple las reglas de su Value Object. */
export class InvalidValueError extends DomainError {
  readonly code = 'INVALID_VALUE';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.field = field;
  }
}
