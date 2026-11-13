import type { z } from 'zod';

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/** Entrada HTTP inválida (cuerpo, query, parámetros o cabeceras) → 400 VALIDATION_ERROR. */
export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly errors: readonly FieldError[];

  constructor(errors: readonly FieldError[]) {
    super('La petición no es válida');
    this.name = 'RequestValidationError';
    this.errors = errors;
  }
}

export type RequestPart = 'body' | 'query' | 'params' | 'headers';

/** Valida una parte de la petición con un esquema del contrato. */
export function parseRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  part: RequestPart,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: [part, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
