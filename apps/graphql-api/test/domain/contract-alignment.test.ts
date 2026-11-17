import { featureFlagsV1 } from '@aegisvolt/contracts';
import { describe, expect, it } from 'vitest';

import { FeatureFlagKey } from '../../src/domain/index.ts';

/** Las claves publicadas en el contrato son claves válidas para el dominio. */
describe('alineación dominio ↔ contrato feature-flags v1', () => {
  it.each(featureFlagsV1.FEATURE_FLAG_KEYS)('%s es una FeatureFlagKey válida', (key) => {
    expect(FeatureFlagKey.parse(key)).toBe(key);
  });
});
