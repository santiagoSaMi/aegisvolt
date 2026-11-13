import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, SERVICE_NAME, loadServiceConfig } from '../src/config.ts';

describe('loadServiceConfig', () => {
  it('usa el nombre fijo del servicio y su puerto por defecto', () => {
    const config = loadServiceConfig({ APP_ENV: 'local' });

    expect(config.serviceName).toBe('saga-orchestrator-service');
    expect(SERVICE_NAME).toBe('saga-orchestrator-service');
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it('falla al arrancar si APP_ENV no es válido', () => {
    expect(() => loadServiceConfig({ APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });
});
