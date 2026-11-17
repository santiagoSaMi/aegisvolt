import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FEATURE_FLAG_CATALOG } from '../src/index.ts';

// Terraform siembra las flags de dev/test/prod desde este JSON (ADR-0033). Si el
// catálogo cambia aquí y no allí, un ambiente nuevo nacería con valores distintos.
const terraformCatalogPath = fileURLToPath(
  new URL('../../../infra/terraform/live/feature-flags.json', import.meta.url),
);

interface TerraformFlag {
  readonly key: string;
  readonly description: string;
  readonly initial: Readonly<Record<'dev' | 'test' | 'prod', boolean>>;
}

describe('catálogo de flags de Terraform', () => {
  const terraform = (
    JSON.parse(readFileSync(terraformCatalogPath, 'utf8')) as { flags: TerraformFlag[] }
  ).flags;

  it('tiene las mismas flags, descripciones y valores iniciales por ambiente que el catálogo', () => {
    const expected = FEATURE_FLAG_CATALOG.map((d) => ({
      key: d.key,
      description: d.description,
      initial: { dev: d.initial.dev, test: d.initial.test, prod: d.initial.prod },
    }));
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
    expect([...terraform].sort(byKey)).toEqual([...expected].sort(byKey));
  });
});
