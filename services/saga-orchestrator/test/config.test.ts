import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, SERVICE_NAME, loadServiceConfig } from '../src/config.ts';

const VALID_ENV = {
  APP_ENV: 'local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  DYNAMODB_TABLE_NAME: 'aegisvolt-sagas-local',
  STATION_RESERVATION_URL: 'http://localhost:4101',
  BILLING_WALLET_URL: 'http://localhost:4102',
  ENERGY_DISPATCH_URL: 'http://localhost:4103',
};

describe('loadServiceConfig', () => {
  it('usa el nombre fijo del servicio, su puerto y una política de reintentos acotada', () => {
    const config = loadServiceConfig(VALID_ENV);

    expect(config.serviceName).toBe('saga-orchestrator-service');
    expect(SERVICE_NAME).toBe('saga-orchestrator-service');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.participants.timeoutMs).toBe(3_000);
    expect(config.saga.forward.maxAttempts).toBe(3);
    expect(config.saga.compensationRounds.maxAttempts).toBe(10);
    expect(config.recovery).toMatchObject({ enabled: true, forwardDeadlineMs: 60_000 });
  });

  it('exige la tabla y las URLs de los tres servicios', () => {
    expect(() => loadServiceConfig({ ...VALID_ENV, ENERGY_DISPATCH_URL: undefined })).toThrow(
      /ENERGY_DISPATCH_URL/,
    );
    expect(() => loadServiceConfig({ ...VALID_ENV, BILLING_WALLET_URL: 'ftp://x' })).toThrow(
      /BILLING_WALLET_URL/,
    );
  });

  it('el lease debe cubrir el tramo más largo sin escribir', () => {
    expect(() => loadServiceConfig({ ...VALID_ENV, SAGA_LEASE_MS: '5000' })).toThrow(
      /SAGA_LEASE_MS/,
    );
  });

  it('falla al arrancar si APP_ENV no es válido', () => {
    expect(() => loadServiceConfig({ ...VALID_ENV, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });
});
