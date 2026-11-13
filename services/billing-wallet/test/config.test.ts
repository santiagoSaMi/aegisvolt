import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, SERVICE_NAME, loadServiceConfig } from '../src/config.ts';

const LOCAL_ENV = {
  APP_ENV: 'local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  DYNAMODB_TABLE_NAME: 'aegisvolt-billing-local',
};

describe('loadServiceConfig', () => {
  it('valores por defecto: COP, tarifas enteras, ventana pico 17–21 h en Bogotá', () => {
    const config = loadServiceConfig(LOCAL_ENV);

    expect(config.serviceName).toBe('billing-wallet-service');
    expect(SERVICE_NAME).toBe('billing-wallet-service');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.pricing).toEqual({
      currency: 'COP',
      tariffMinorPerKwh: { STANDARD: 80_000, FAST: 100_000, ULTRA_FAST: 140_000 },
      surgeMultiplierBasisPoints: 12_500,
      peakWindows: [{ startMinute: 1020, endMinute: 1260 }],
      utcOffsetMinutes: -300,
    });
    expect(config.featureFlags.ENABLE_DYNAMIC_SURGE_PRICING).toBe(false);
  });

  it('en local exige un endpoint de AWS explícito', () => {
    expect(() => loadServiceConfig({ ...LOCAL_ENV, AWS_ENDPOINT_URL: undefined })).toThrow(
      /AWS_ENDPOINT_URL/,
    );
  });

  it('rechaza tarifas no enteras, monedas inválidas y ventanas mal formadas', () => {
    expect(() =>
      loadServiceConfig({ ...LOCAL_ENV, PRICING_TARIFF_FAST_MINOR_PER_KWH: '1000.5' }),
    ).toThrow(/PRICING_TARIFF_FAST_MINOR_PER_KWH/);
    expect(() => loadServiceConfig({ ...LOCAL_ENV, WALLET_CURRENCY: 'pesos' })).toThrow(
      /WALLET_CURRENCY/,
    );
    expect(() => loadServiceConfig({ ...LOCAL_ENV, PRICING_PEAK_WINDOWS: '5pm-9pm' })).toThrow(
      /PRICING_PEAK_WINDOWS/,
    );
  });

  it('acepta varias ventanas pico', () => {
    const config = loadServiceConfig({
      ...LOCAL_ENV,
      PRICING_PEAK_WINDOWS: '06:30-08:00, 17:00-21:00',
    });
    expect(config.pricing.peakWindows).toEqual([
      { startMinute: 390, endMinute: 480 },
      { startMinute: 1020, endMinute: 1260 },
    ]);
  });
});
