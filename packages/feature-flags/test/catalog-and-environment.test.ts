import { featureFlagsV1 } from '@aegisvolt/contracts';
import { describe, expect, it } from 'vitest';

import {
  CachedFeatureFlagReader,
  FEATURE_FLAG_CATALOG,
  FeatureFlagsTableError,
  definitionOf,
  resolveFeatureFlagsTable,
  type FeatureFlagState,
} from '../src/index.ts';

describe('catálogo de flags', () => {
  it('cubre exactamente las flags del contrato, con el servicio que las evalúa', () => {
    expect(FEATURE_FLAG_CATALOG.map((d) => d.key).sort()).toEqual(
      [...featureFlagsV1.FEATURE_FLAG_KEYS].sort(),
    );
    for (const definition of FEATURE_FLAG_CATALOG) {
      expect(definition.evaluatedBy).toBe(featureFlagsV1.FEATURE_FLAG_EVALUATORS[definition.key]);
      expect(definition.safeDefault).toBe(false);
    }
  });

  it('valores iniciales por ambiente (§2.2 y fase de feature flags)', () => {
    expect(definitionOf('ENABLE_DYNAMIC_SURGE_PRICING').initial).toMatchObject({
      dev: true,
      test: true,
      prod: false,
    });
    expect(definitionOf('SIMULATE_CHARGER_HARDWARE_FAULT').initial).toMatchObject({
      dev: false,
      test: true,
      prod: false,
    });
    expect(definitionOf('ENABLE_FAST_CHARGE_BOOST').initial).toMatchObject({
      dev: true,
      test: false,
      prod: false,
    });
  });
});

describe('resolveFeatureFlagsTable: la tabla sale del ambiente del despliegue', () => {
  it('por defecto, la tabla del propio ambiente', () => {
    expect(resolveFeatureFlagsTable('dev', undefined)).toBe('aegisvolt-feature-flags-dev');
    expect(resolveFeatureFlagsTable('prod', '')).toBe('aegisvolt-feature-flags-prod');
    expect(resolveFeatureFlagsTable('local', undefined)).toBe('aegisvolt-feature-flags-local');
  });

  it('en dev/test/prod no se puede apuntar a la tabla de otro ambiente', () => {
    expect(() => resolveFeatureFlagsTable('dev', 'aegisvolt-feature-flags-prod')).toThrow(
      FeatureFlagsTableError,
    );
    expect(() => resolveFeatureFlagsTable('test', 'aegisvolt-feature-flags-it-123')).toThrow(
      /aegisvolt-feature-flags-test/,
    );
    expect(resolveFeatureFlagsTable('prod', 'aegisvolt-feature-flags-prod')).toBe(
      'aegisvolt-feature-flags-prod',
    );
  });

  it('en local admite tablas temporales con el prefijo', () => {
    expect(resolveFeatureFlagsTable('local', 'aegisvolt-feature-flags-e2e-1a2b')).toBe(
      'aegisvolt-feature-flags-e2e-1a2b',
    );
    expect(() => resolveFeatureFlagsTable('local', 'otra-tabla')).toThrow(FeatureFlagsTableError);
  });
});

describe('CachedFeatureFlagReader.invalidate', () => {
  it('descarta el valor en caché: la siguiente lectura va al almacén', async () => {
    let enabled = false;
    const state = (): FeatureFlagState => ({
      key: 'ENABLE_FAST_CHARGE_BOOST',
      enabled,
      version: enabled ? 2 : 1,
      updatedAt: '2026-11-13T12:00:00.000Z',
      updatedBy: 'admin',
    });
    const reader = new CachedFeatureFlagReader(
      { fetch: () => Promise.resolve(state()) },
      { ttlMs: 60_000 },
    );

    expect(await reader.isEnabled('ENABLE_FAST_CHARGE_BOOST')).toBe(false);
    enabled = true;
    expect(await reader.isEnabled('ENABLE_FAST_CHARGE_BOOST')).toBe(false); // en caché
    reader.invalidate('ENABLE_FAST_CHARGE_BOOST');
    expect(await reader.isEnabled('ENABLE_FAST_CHARGE_BOOST')).toBe(true);
  });
});
