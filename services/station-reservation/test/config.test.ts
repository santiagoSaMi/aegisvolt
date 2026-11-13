import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, SERVICE_NAME, loadServiceConfig } from '../src/config.ts';

const LOCAL_ENV = {
  APP_ENV: 'local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  DYNAMODB_TABLE_NAME: 'aegisvolt-reservations-local',
};

describe('loadServiceConfig', () => {
  it('usa el nombre fijo del servicio, su puerto y valores por defecto', () => {
    const config = loadServiceConfig(LOCAL_ENV);

    expect(config.serviceName).toBe('station-reservation-service');
    expect(SERVICE_NAME).toBe('station-reservation-service');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.aws.endpointUrl).toBe('http://localhost:4566');
    expect(config.dynamodb).toEqual({
      tableName: 'aegisvolt-reservations-local',
      connectionTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      maxAttempts: 2,
    });
    expect(config.reservationPolicy).toEqual({ standardHoldMs: 120_000, boostedHoldMs: 300_000 });
    expect(config.featureFlags.ENABLE_FAST_CHARGE_BOOST).toBe(false);
  });

  it('en local exige un endpoint de AWS explícito (nunca AWS real por omisión)', () => {
    expect(() => loadServiceConfig({ ...LOCAL_ENV, AWS_ENDPOINT_URL: undefined })).toThrow(
      /AWS_ENDPOINT_URL/,
    );
  });

  it('fuera de local el endpoint es opcional (AWS real usa el regional)', () => {
    const config = loadServiceConfig({
      APP_ENV: 'prod',
      DYNAMODB_TABLE_NAME: 'aegisvolt-reservations-prod',
    });
    expect(config.aws.endpointUrl).toBeUndefined();
  });

  it('valida el endpoint, la tabla y la coherencia de los timeouts', () => {
    expect(() => loadServiceConfig({ ...LOCAL_ENV, AWS_ENDPOINT_URL: 'no-es-url' })).toThrow(
      /AWS_ENDPOINT_URL/,
    );
    expect(() => loadServiceConfig({ ...LOCAL_ENV, DYNAMODB_TABLE_NAME: '' })).toThrow(
      /DYNAMODB_TABLE_NAME/,
    );
    expect(() =>
      loadServiceConfig({
        ...LOCAL_ENV,
        HTTP_REQUEST_TIMEOUT_MS: '3000',
        DYNAMODB_REQUEST_TIMEOUT_MS: '2000',
        DYNAMODB_MAX_ATTEMPTS: '2',
      }),
    ).toThrow(/HTTP_REQUEST_TIMEOUT_MS/);
  });

  it('activa la flag provisional solo con "true"', () => {
    expect(
      loadServiceConfig({ ...LOCAL_ENV, FEATURE_ENABLE_FAST_CHARGE_BOOST: 'true' }).featureFlags
        .ENABLE_FAST_CHARGE_BOOST,
    ).toBe(true);
    expect(() =>
      loadServiceConfig({ ...LOCAL_ENV, FEATURE_ENABLE_FAST_CHARGE_BOOST: 'yes' }),
    ).toThrow(/FEATURE_ENABLE_FAST_CHARGE_BOOST/);
  });
});
