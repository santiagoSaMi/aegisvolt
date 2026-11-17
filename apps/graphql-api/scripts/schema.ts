// Snapshot y compatibilidad del esquema GraphQL (ADR-0035, check `graphql-schema`).
//
// Uso (desde apps/graphql-api):
//   node scripts/schema.ts --write                 escribe schema.graphql (SDL normalizado)
//   node scripts/schema.ts --check                 falla si schema.graphql no coincide con typeDefs
//   node scripts/schema.ts --breaking <base.sdl>   lista cambios incompatibles y riesgosos frente
//                                                  al esquema de la rama destino (Markdown)
//
// schema.graphql es el contrato publicado: un cambio en typeDefs exige regenerarlo, así
// el diff del PR muestra el cambio de contrato y la consola web se valida contra él.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildSchema,
  findBreakingChanges,
  findDangerousChanges,
  lexicographicSortSchema,
  printSchema,
} from 'graphql';

import { typeDefs } from '../src/presentation/graphql/schema.ts';

const snapshotPath = fileURLToPath(new URL('../schema.graphql', import.meta.url));
const current = lexicographicSortSchema(buildSchema(typeDefs));
const printed = `${printSchema(current)}\n`;
const [mode, arg] = process.argv.slice(2);

if (mode === '--write') {
  writeFileSync(snapshotPath, printed);
  process.stdout.write(`schema.graphql actualizado (${printed.length} bytes).\n`);
} else if (mode === '--check') {
  const committed = readFileSync(snapshotPath, 'utf8');
  if (committed !== printed) {
    process.stderr.write(
      'schema.graphql no coincide con typeDefs. Ejecute `node scripts/schema.ts --write` y revise el diff.\n',
    );
    process.exit(1);
  }
  const types = Object.keys(current.getTypeMap()).filter((name) => !name.startsWith('__'));
  process.stdout.write(`Esquema válido y snapshot al día (${types.length} tipos).\n`);
} else if (mode === '--breaking' && arg !== undefined) {
  const base = buildSchema(readFileSync(arg, 'utf8'));
  const breaking = findBreakingChanges(base, current);
  const dangerous = findDangerousChanges(base, current);
  const lines = [
    `**${breaking.length}** cambios incompatibles · **${dangerous.length}** riesgosos`,
  ];
  for (const change of breaking) lines.push(`- ❌ \`${change.type}\`: ${change.description}`);
  for (const change of dangerous) lines.push(`- ⚠️ \`${change.type}\`: ${change.description}`);
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  process.stderr.write(
    'Uso: node scripts/schema.ts --write | --check | --breaking <base.graphql>\n',
  );
  process.exit(2);
}
