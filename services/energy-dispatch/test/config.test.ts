import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, SERVICE_NAME, loadServiceConfig } from '../src/config.ts';

const VALID_ENV = {
  APP_ENV: 'local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  DYNAMODB_TABLE_NAME: 'aegisvolt-dispatch-local',
  FEATURE_FLAGS_TABLE_NAME: 'aegisvolt-feature-flags-local',
};

describe('loadServiceConfig', () => {
  it('usa el nombre fijo del servicio, su puerto y valores por defecto seguros', () => {
    const config = loadServiceConfig(VALID_ENV);

    expect(config.serviceName).toBe('energy-dispatch-service');
    expect(SERVICE_NAME).toBe('energy-dispatch-service');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.featureFlags).toEqual({
      tableName: 'aegisvolt-feature-flags-local',
      cacheTtlMs: 5_000,
    });
    expect(config.shutdown).toEqual({ drainDelayMs: 0, graceMs: 10_000 });
    expect(config.telemetry.retentionDays).toBe(30);
  });

  it('exige la tabla del servicio; la de flags se deriva del ambiente del despliegue', () => {
    expect(() => loadServiceConfig({ ...VALID_ENV, DYNAMODB_TABLE_NAME: undefined })).toThrow(
      /DYNAMODB_TABLE_NAME/,
    );
    expect(
      loadServiceConfig({ ...VALID_ENV, FEATURE_FLAGS_TABLE_NAME: undefined }).featureFlags
        .tableName,
    ).toBe('aegisvolt-feature-flags-local');
    expect(() =>
      loadServiceConfig({
        ...VALID_ENV,
        APP_ENV: 'test',
        AWS_ENDPOINT_URL: undefined,
        FEATURE_FLAGS_TABLE_NAME: 'aegisvolt-feature-flags-prod',
      }),
    ).toThrow(/FEATURE_FLAGS_TABLE_NAME/);
  });

  it('en local exige un endpoint explícito (nunca AWS real por defecto)', () => {
    expect(() => loadServiceConfig({ ...VALID_ENV, AWS_ENDPOINT_URL: undefined })).toThrow(
      /AWS_ENDPOINT_URL/,
    );
  });

  it('valida la coherencia de los presupuestos de tiempo', () => {
    expect(() => loadServiceConfig({ ...VALID_ENV, HTTP_REQUEST_TIMEOUT_MS: '3000' })).toThrow(
      /HTTP_REQUEST_TIMEOUT_MS/,
    );
    expect(() => loadServiceConfig({ ...VALID_ENV, SHUTDOWN_GRACE_MS: '4000' })).toThrow(
      /SHUTDOWN_GRACE_MS/,
    );
  });

  it('falla al arrancar si APP_ENV no es válido', () => {
    expect(() => loadServiceConfig({ ...VALID_ENV, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });
});
