import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Kind, buildSchema, validate, type DocumentNode } from 'graphql';
import { describe, expect, it } from 'vitest';

// Contrato publicado por el BFF (apps/graphql-api/schema.graphql, regenerado y comprobado
// en el check `graphql-schema`, ADR-0035). Se lee como archivo: la web no depende del
// código del BFF.
// import.meta.url no es file: en el entorno jsdom; import.meta.dirname sí es la ruta real.
const schemaPath = resolve(import.meta.dirname, '../../../graphql-api/schema.graphql');
const schema = buildSchema(readFileSync(schemaPath, 'utf8'));

// Todas las operaciones que la consola envía, ya compuestas con sus fragmentos.
const modules = import.meta.glob<Record<string, unknown>>(
  ['../../src/features/*/api.ts', '../../src/shared/api/*.ts'],
  { eager: true },
);

// Documentos con al menos una operación. Los documentos que solo contienen un fragmento
// (p. ej. SAGA_FIELDS) se validan dentro de las operaciones que los usan.
function isOperationDocument(value: unknown): value is DocumentNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'Document' &&
    (value as DocumentNode).definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION)
  );
}

const operations = Object.entries(modules).flatMap(([file, exports]) =>
  Object.entries(exports)
    .filter(([, value]) => isOperationDocument(value))
    .map(([name, value]) => ({
      id: `${file.replace('../../src/', '')}#${name}`,
      document: value as DocumentNode,
    })),
);

describe('operaciones GraphQL de la consola frente al esquema del BFF', () => {
  it('encuentra todas las operaciones exportadas', () => {
    expect(operations.length).toBeGreaterThanOrEqual(14);
  });

  it.each(operations.map((op) => [op.id, op.document] as const))(
    '%s es válida',
    (_id, document) => {
      expect(validate(schema, document).map((error) => error.message)).toEqual([]);
    },
  );
});
