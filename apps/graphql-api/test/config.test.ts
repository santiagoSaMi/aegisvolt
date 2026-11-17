import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, SERVICE_NAME, loadFlagsConfig, loadServiceConfig } from '../src/config.ts';

const LOCAL = { APP_ENV: 'local', AWS_ENDPOINT_URL: 'http://localhost:4566' };
const SERVER = {
  ...LOCAL,
  STATION_RESERVATION_URL: 'http://localhost:4101',
  BILLING_WALLET_URL: 'http://localhost:4102',
  ENERGY_DISPATCH_URL: 'http://localhost:4103',
  SAGA_ORCHESTRATOR_URL: 'http://localhost:4100',
  COGNITO_ISSUER: 'http://floci:4566/us-east-1_abc/',
  COGNITO_CLIENT_ID: 'client-123',
};

describe('loadFlagsConfig', () => {
  it('usa el nombre fijo del servicio, su puerto y la tabla de flags del ambiente', () => {
    const config = loadFlagsConfig(LOCAL);

    expect(config.serviceName).toBe('graphql-api');
    expect(SERVICE_NAME).toBe('graphql-api');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.featureFlags).toEqual({
      tableName: 'aegisvolt-feature-flags-local',
      cacheTtlMs: 5_000,
    });
    expect(loadFlagsConfig({ APP_ENV: 'prod' }).featureFlags.tableName).toBe(
      'aegisvolt-feature-flags-prod',
    );
  });

  it('un despliegue de dev no puede apuntar a la tabla de prod (no arranca)', () => {
    expect(() =>
      loadFlagsConfig({ APP_ENV: 'dev', FEATURE_FLAGS_TABLE_NAME: 'aegisvolt-feature-flags-prod' }),
    ).toThrow(/FEATURE_FLAGS_TABLE_NAME/);
  });

  it('falla al arrancar si APP_ENV no es válido', () => {
    expect(() => loadFlagsConfig({ ...LOCAL, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });
});

describe('loadServiceConfig (servidor GraphQL)', () => {
  it('servicios internos, timeouts, Cognito y límites con valores por defecto razonables', () => {
    const config = loadServiceConfig(SERVER);

    expect(config.upstreams).toMatchObject({
      sagaOrchestratorUrl: 'http://localhost:4100',
      timeoutMs: 3_000,
      maxRetries: 1,
      sagaStartTimeoutMs: 25_000,
    });
    expect(config.cognito).toEqual({
      issuer: 'http://floci:4566/us-east-1_abc',
      clientId: 'client-123',
      jwksUrl: 'http://floci:4566/us-east-1_abc/.well-known/jwks.json',
    });
    expect(config.graphql).toEqual({ introspection: true, maxDepth: 8 });
  });

  it('introspección deshabilitada por defecto en prod', () => {
    const prod = { ...SERVER, APP_ENV: 'prod', AWS_ENDPOINT_URL: undefined };
    expect(loadServiceConfig(prod).graphql.introspection).toBe(false);
  });

  it('exige las URLs de los servicios y la configuración de Cognito', () => {
    expect(() => loadServiceConfig({ ...SERVER, SAGA_ORCHESTRATOR_URL: undefined })).toThrow(
      /SAGA_ORCHESTRATOR_URL/,
    );
    expect(() => loadServiceConfig({ ...SERVER, COGNITO_CLIENT_ID: undefined })).toThrow(
      /COGNITO_CLIENT_ID/,
    );
    expect(() => loadServiceConfig({ ...SERVER, UPSTREAM_MAX_RETRIES: '9' })).toThrow(
      /UPSTREAM_MAX_RETRIES/,
    );
  });
});
