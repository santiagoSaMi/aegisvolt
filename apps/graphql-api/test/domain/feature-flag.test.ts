import { describe, expect, it } from 'vitest';

import { ActorId, FeatureFlag, FeatureFlagKey, InvalidValueError } from '../../src/domain/index.ts';

const NOW = new Date('2026-11-13T15:00:00.000Z');
const LATER = new Date('2026-11-13T15:05:00.000Z');
const ADMIN = ActorId.parse('admin@aegisvolt.test');

function surgeFlag(enabled = false): FeatureFlag {
  return FeatureFlag.define({
    key: FeatureFlagKey.parse('ENABLE_DYNAMIC_SURGE_PRICING'),
    enabled,
    description: 'Tarifas dinámicas en horas pico',
    definedBy: ActorId.parse('terraform'),
    now: NOW,
  });
}

describe('Value Objects', () => {
  it('FeatureFlagKey exige MAYÚSCULAS_CON_GUIONES_BAJOS', () => {
    expect(FeatureFlagKey.parse('ENABLE_FAST_CHARGE_BOOST')).toBe('ENABLE_FAST_CHARGE_BOOST');
    expect(() => FeatureFlagKey.parse('enable_x')).toThrow(InvalidValueError);
    expect(() => FeatureFlagKey.parse('AB')).toThrow(InvalidValueError);
  });

  it('ActorId no admite vacíos ni espacios', () => {
    expect(() => ActorId.parse('')).toThrow(InvalidValueError);
    expect(() => ActorId.parse('a b')).toThrow(InvalidValueError);
  });
});

describe('FeatureFlag', () => {
  it('se define con versión 1', () => {
    const flag = surgeFlag();
    expect(flag).toMatchObject({ enabled: false, version: 1, updatedBy: 'terraform' });
  });

  it('cambiar el estado sube la versión y produce auditoría', () => {
    const { flag, change } = surgeFlag(false).setEnabled(true, ADMIN, LATER);

    expect(flag).toMatchObject({ enabled: true, version: 2, updatedBy: ADMIN, updatedAt: LATER });
    expect(change).toEqual({
      key: 'ENABLE_DYNAMIC_SURGE_PRICING',
      from: false,
      to: true,
      version: 2,
      changedBy: ADMIN,
      changedAt: LATER,
    });
  });

  it('fijar el mismo valor es idempotente: sin cambio ni auditoría', () => {
    const original = surgeFlag(true);
    const result = original.setEnabled(true, ADMIN, LATER);
    expect(result.flag).toBe(original);
    expect(result.change).toBeUndefined();
  });

  it('valida descripción y versión', () => {
    const base = {
      key: FeatureFlagKey.parse('SIMULATE_CHARGER_HARDWARE_FAULT'),
      enabled: false,
      updatedBy: ADMIN,
      updatedAt: NOW,
    };
    expect(() => FeatureFlag.restore({ ...base, description: '  ', version: 1 })).toThrow(
      InvalidValueError,
    );
    expect(() => FeatureFlag.restore({ ...base, description: 'x', version: 0 })).toThrow(
      InvalidValueError,
    );
  });
});
