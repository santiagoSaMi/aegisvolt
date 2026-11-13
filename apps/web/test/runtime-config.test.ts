import { describe, expect, it } from 'vitest';

import {
  RuntimeConfigError,
  loadRuntimeConfig,
  parseRuntimeConfig,
} from '../src/config/runtime-config.ts';

describe('parseRuntimeConfig', () => {
  it('acepta una configuración válida', () => {
    expect(parseRuntimeConfig({ environment: 'test', graphqlUrl: './graphql' })).toEqual({
      environment: 'test',
      graphqlUrl: './graphql',
    });
  });

  it.each([
    [null, /objeto/],
    [{ environment: 'staging', graphqlUrl: '/graphql' }, /environment/],
    [{ environment: 'dev', graphqlUrl: '  ' }, /graphqlUrl/],
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
      return Promise.resolve(Response.json({ environment: 'prod', graphqlUrl: './graphql' }));
    };

    await expect(loadRuntimeConfig(fakeFetch)).resolves.toMatchObject({ environment: 'prod' });
    expect(requested).toEqual({ url: './config.json', cache: 'no-store' });
  });

  it('falla con un error claro si config.json no está disponible', async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }));

    await expect(loadRuntimeConfig(fakeFetch)).rejects.toThrow(RuntimeConfigError);
  });
});
