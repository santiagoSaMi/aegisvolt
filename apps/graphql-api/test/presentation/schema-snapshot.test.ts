import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildSchema, lexicographicSortSchema, printSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { typeDefs } from '../../src/presentation/graphql/schema.ts';

// schema.graphql es el contrato publicado (lo valida la consola web, ADR-0035).
describe('snapshot del esquema (schema.graphql)', () => {
  it('coincide con typeDefs; si cambia: node scripts/schema.ts --write y revisar el diff', () => {
    const committed = readFileSync(
      fileURLToPath(new URL('../../schema.graphql', import.meta.url)),
      'utf8',
    );
    expect(committed).toBe(`${printSchema(lexicographicSortSchema(buildSchema(typeDefs)))}\n`);
  });
});
