import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, SERVICE_NAME, loadServiceConfig } from '../src/config.ts';

const LOCAL = { APP_ENV: 'local', AWS_ENDPOINT_URL: 'http://localhost:4566' };

describe('loadServiceConfig', () => {
  it('usa el nombre fijo del servicio y su puerto por defecto', () => {
    const config = loadServiceConfig(LOCAL);

    expect(config.serviceName).toBe('graphql-api');
    expect(SERVICE_NAME).toBe('graphql-api');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.featureFlags).toEqual({
      tableName: 'aegisvolt-feature-flags-local',
      cacheTtlMs: 5_000,
    });
  });

  it('la tabla de flags la determina el ambiente del despliegue', () => {
    expect(loadServiceConfig({ APP_ENV: 'dev' }).featureFlags.tableName).toBe(
      'aegisvolt-feature-flags-dev',
    );
    expect(loadServiceConfig({ APP_ENV: 'prod' }).featureFlags.tableName).toBe(
      'aegisvolt-feature-flags-prod',
    );
  });

  it('un despliegue de dev no puede apuntar a la tabla de prod (no arranca)', () => {
    expect(() =>
      loadServiceConfig({
        APP_ENV: 'dev',
        FEATURE_FLAGS_TABLE_NAME: 'aegisvolt-feature-flags-prod',
      }),
    ).toThrow(/FEATURE_FLAGS_TABLE_NAME/);
  });

  it('falla al arrancar si APP_ENV no es válido', () => {
    expect(() => loadServiceConfig({ ...LOCAL, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });
});
