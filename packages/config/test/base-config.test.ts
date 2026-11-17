import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigValidationError, loadBaseConfig, parseEnv } from '../src/index.ts';

const options = { serviceName: 'example-service', defaultPort: 4999 } as const;

describe('loadBaseConfig', () => {
  it('aplica valores por defecto y el nombre fijo del servicio', () => {
    const config = loadBaseConfig({ APP_ENV: 'local' }, options);

    expect(config).toEqual({
      serviceName: 'example-service',
      appEnv: 'local',
      serviceVersion: 'local',
      port: 4999,
      logLevel: 'info',
      aws: { region: 'us-east-1' },
    });
  });

  it('convierte PORT a número e incluye el endpoint local de AWS', () => {
    const config = loadBaseConfig(
      {
        APP_ENV: 'dev',
        PORT: '8080',
        LOG_LEVEL: 'debug',
        AWS_ENDPOINT_URL: 'http://localhost:4566',
      },
      options,
    );

    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('debug');
    expect(config.aws.endpointUrl).toBe('http://localhost:4566');
  });

  it('reporta todas las variables inválidas sin exponer sus valores', () => {
    const act = () =>
      loadBaseConfig(
        { APP_ENV: 'staging', PORT: 'no-es-numero', LOG_LEVEL: 'secreto-123' },
        options,
      );

    expect(act).toThrow(ConfigValidationError);
    try {
      act();
    } catch (error) {
      const configError = error as ConfigValidationError;
      expect(configError.issues.map((issue) => issue.variable).sort()).toEqual([
        'APP_ENV',
        'LOG_LEVEL',
        'PORT',
      ]);
      expect(configError.message).not.toContain('secreto-123');
    }
  });
});

describe('parseEnv', () => {
  it('permite que cada servicio extienda el esquema base', () => {
    const schema = z.object({ TABLE_NAME: z.string().min(1) });

    expect(parseEnv(schema, { TABLE_NAME: 'aegisvolt-example-dev' })).toEqual({
      TABLE_NAME: 'aegisvolt-example-dev',
    });
    expect(() => parseEnv(schema, {})).toThrow(/TABLE_NAME/);
  });
});
