import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  Energy,
  InvalidValueError,
  Money,
  PricingPolicy,
  powerClassFor,
} from '../../src/domain/index.ts';
import { OFF_PEAK, PEAK, cop, pricing } from './fixtures.ts';

describe('Money', () => {
  it('suma y resta en unidades menores', () => {
    expect(cop(1_000).add(cop(250)).amountMinor).toBe(1_250);
    expect(cop(1_000).subtract(cop(250)).amountMinor).toBe(750);
    expect(cop(5).equals(Money.of(5, 'COP'))).toBe(true);
  });

  it.each([
    [-1, 'COP'],
    [1.5, 'COP'],
    [Number.MAX_SAFE_INTEGER + 1, 'COP'],
    [10, 'cop'],
  ])('rechaza Money.of(%s, %s)', (amount, currency) => {
    expect(() => Money.of(amount, currency)).toThrow(InvalidValueError);
  });

  it('nunca produce importes negativos', () => {
    expect(() => cop(10).subtract(cop(11))).toThrow(InvalidValueError);
  });

  it('no mezcla monedas', () => {
    expect(() => cop(10).add(Money.of(10, 'USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('Energy', () => {
  it('se representa en Wh enteros', () => {
    expect(Energy.fromKwh(32.125).wattHours).toBe(32_125);
    expect(Energy.fromKwh(0.3).kwh).toBe(0.3);
  });

  it.each([0, -1, 500.001, 1.0001, Number.NaN])('rechaza %s kWh', (kwh) => {
    expect(() => Energy.fromKwh(kwh)).toThrow(InvalidValueError);
  });
});

describe('powerClassFor', () => {
  it.each([
    [22, 'STANDARD'],
    [50, 'FAST'],
    [149.9, 'FAST'],
    [150, 'ULTRA_FAST'],
  ])('%s kW → %s', (kw, expected) => {
    expect(powerClassFor(kw)).toBe(expected);
  });
});

describe('PricingPolicy (ENABLE_DYNAMIC_SURGE_PRICING)', () => {
  it('importe = tarifa × energía fuera de hora pico', () => {
    const quote = pricing.quote({
      energy: Energy.fromKwh(30),
      connectorPowerKw: 60,
      at: OFF_PEAK,
      surgePricingEnabled: true,
    });
    expect(quote).toMatchObject({
      tariffMinorPerKwh: 100_000,
      surgeMultiplierBasisPoints: 10_000,
      surgeApplied: false,
    });
    expect(quote.amount.amountMinor).toBe(3_000_000);
  });

  it('aplica el surge solo con la flag activa y en hora pico (hora local de Bogotá)', () => {
    const base = { energy: Energy.fromKwh(30), connectorPowerKw: 60, at: PEAK };
    const surge = pricing.quote({ ...base, surgePricingEnabled: true });
    const noFlag = pricing.quote({ ...base, surgePricingEnabled: false });

    expect(surge.surgeApplied).toBe(true);
    expect(surge.amount.amountMinor).toBe(3_750_000);
    expect(noFlag.surgeApplied).toBe(false);
    expect(noFlag.amount.amountMinor).toBe(3_000_000);
  });

  it('calcula con enteros y redondea half-up a la unidad menor', () => {
    // 80 000 minor/kWh × 0,001 kWh × 1,25 = 100 (exacto).
    expect(
      pricing.quote({
        energy: Energy.fromKwh(0.001),
        connectorPowerKw: 22,
        at: PEAK,
        surgePricingEnabled: true,
      }).amount.amountMinor,
    ).toBe(100);
    const odd = new PricingPolicy({
      ...pricing.config,
      tariffMinorPerKwh: { STANDARD: 3, FAST: 3, ULTRA_FAST: 3 },
    });
    // 3 minor/kWh × 0,167 kWh = 0,501 → redondea a 1.
    expect(
      odd.quote({
        energy: Energy.fromKwh(0.167),
        connectorPowerKw: 22,
        at: OFF_PEAK,
        surgePricingEnabled: false,
      }).amount.amountMinor,
    ).toBe(1);
  });

  it('la ventana pico es [inicio, fin)', () => {
    expect(pricing.isPeakAt(new Date('2026-11-13T22:00:00.000Z'))).toBe(true); // 17:00 local
    expect(pricing.isPeakAt(new Date('2026-11-14T02:00:00.000Z'))).toBe(false); // 21:00 local
  });

  it('valida su configuración', () => {
    expect(
      () => new PricingPolicy({ ...pricing.config, surgeMultiplierBasisPoints: 9_000 }),
    ).toThrow(InvalidValueError);
    expect(
      () =>
        new PricingPolicy({
          ...pricing.config,
          peakWindows: [{ startMinute: 600, endMinute: 600 }],
        }),
    ).toThrow(InvalidValueError);
    expect(
      () =>
        new PricingPolicy({
          ...pricing.config,
          tariffMinorPerKwh: { STANDARD: 0, FAST: 1, ULTRA_FAST: 1 },
        }),
    ).toThrow(InvalidValueError);
  });
});
