import { describe, expect, it } from 'vitest';

import {
  RuntimeConfigError,
  loadRuntimeConfig,
  parseRuntimeConfig,
} from '../src/config/runtime-config.ts';

const valid = {
  environment: 'test',
  graphqlUrl: './graphql',
  auth: { cognitoUrl: './auth/cognito', clientId: 'client-123' },
};

describe('parseRuntimeConfig', () => {
  it('acepta una configuración válida y aplica valores por defecto', () => {
    expect(parseRuntimeConfig(valid)).toEqual({
      ...valid,
      pollingIntervalMs: 5000,
      cities: ['bogota'],
    });
  });

  it.each([
    [null, /objeto/],
    [{ ...valid, environment: 'staging' }, /environment/],
    [{ ...valid, graphqlUrl: '  ' }, /graphqlUrl/],
    [{ ...valid, auth: { cognitoUrl: './auth/cognito' } }, /auth\.clientId/],
    [{ ...valid, pollingIntervalMs: 100 }, /pollingIntervalMs/],
    [{ ...valid, cities: ['Bogotá'] }, /cities/],
  ])('rechaza %j', (value, message) => {
    expect(() => parseRuntimeConfig(value)).toThrow(message);
  });
});

describe('loadRuntimeConfig', () => {
  it('lee config.json sin caché', async () => {
    let requested: { url: string; cache: RequestCache | undefined } | undefined;
    const fakeFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      requested = { url, cache: init?.cache };
      return Promise.resolve(Response.json({ ...valid, environment: 'prod' }));
    };

    await expect(loadRuntimeConfig(fakeFetch)).resolves.toMatchObject({ environment: 'prod' });
    expect(requested).toEqual({ url: './config.json', cache: 'no-store' });
  });

  it('falla con un error claro si config.json no está disponible', async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }));

    await expect(loadRuntimeConfig(fakeFetch)).rejects.toThrow(RuntimeConfigError);
  });
});
