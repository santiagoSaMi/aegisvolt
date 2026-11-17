import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function toIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' && ISO_UTC.test(value)) {
    return value;
  }
  throw new GraphQLError('DateTime debe ser una fecha ISO 8601 en UTC');
}

/** Fecha y hora UTC en ISO 8601 (entrada y salida como texto). */
export const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  serialize: toIso,
  parseValue: toIso,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError('DateTime debe ser un texto ISO 8601');
    }
    return toIso(ast.value);
  },
});

function toSafeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new GraphQLError('SafeInt debe ser un entero con |n| ≤ 2^53 − 1');
}

/** Entero seguro en JavaScript (importes en unidades menores que exceden Int de 32 bits). */
export const SafeIntScalar = new GraphQLScalarType({
  name: 'SafeInt',
  serialize: toSafeInt,
  parseValue: toSafeInt,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.INT) {
      throw new GraphQLError('SafeInt debe ser un entero');
    }
    return toSafeInt(Number(ast.value));
  },
});
