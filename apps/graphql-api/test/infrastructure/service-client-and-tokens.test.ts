import { runWithLogContext } from '@aegisvolt/logger';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  UnauthorizedError,
  UpstreamRejectedError,
  UpstreamUnavailableError,
} from '../../src/application/index.ts';
import { CognitoTokenVerifier } from '../../src/infrastructure/auth/cognito-token-verifier.ts';
import { ServiceClient } from '../../src/infrastructure/http/service-client.ts';

const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';

function client(responses: (() => Promise<Response>)[]) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const http = new ServiceClient({
    service: 'svc',
    baseUrl: 'http://svc:4000',
    timeoutMs: 50,
    maxRetries: 1,
    retryDelayMs: 1,
    fetch: (url, init) => {
      seen.push({
        url: url instanceof Request ? url.url : url.toString(),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const next = responses.shift();
      return next === undefined ? Promise.reject(new Error('sin respuesta')) : next();
    },
  });
  return { http, seen };
}

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
const schema = z.object({ ok: z.boolean() });

describe('ServiceClient (llamadas internas)', () => {
  it('propaga el correlation_id de la petición y añade la query', async () => {
    const { http, seen } = client([() => json(200, { ok: true })]);
    await runWithLogContext({ correlationId: CORRELATION_ID }, () =>
      http.call({
        method: 'GET',
        path: '/v1/x',
        query: { limit: 5, cursor: undefined },
        schema,
        idempotent: true,
      }),
    );
    expect(seen[0]?.url).toBe('http://svc:4000/v1/x?limit=5');
    expect(seen[0]?.headers['x-correlation-id']).toBe(CORRELATION_ID);
  });

  it('reintenta una operación idempotente ante 503 o timeout, una vez', async () => {
    const { http, seen } = client([() => json(503, {}), () => json(200, { ok: true })]);
    expect(await http.call({ method: 'GET', path: '/v1/x', schema, idempotent: true })).toEqual({
      ok: true,
    });
    expect(seen).toHaveLength(2);

    const slow = client([
      () =>
        new Promise<Response>((_r, reject) =>
          setTimeout(() => {
            reject(new DOMException('t', 'TimeoutError'));
          }, 60),
        ),
      () =>
        new Promise<Response>((_r, reject) =>
          setTimeout(() => {
            reject(new DOMException('t', 'TimeoutError'));
          }, 60),
        ),
    ]);
    await expect(
      slow.http.call({ method: 'GET', path: '/v1/x', schema, idempotent: true }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(slow.seen).toHaveLength(2);
  });

  it('NO reintenta una operación no idempotente, ni un 4xx, ni un 500', async () => {
    const write = client([() => json(503, {}), () => json(200, { ok: true })]);
    await expect(
      write.http.call({ method: 'POST', path: '/v1/x', schema, idempotent: false }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(write.seen).toHaveLength(1);

    const rejected = client([
      () =>
        json(409, {
          type: 't',
          title: 't',
          status: 409,
          code: 'CONNECTOR_UNAVAILABLE',
          detail: 'ocupado',
        }),
    ]);
    await expect(
      rejected.http.call({ method: 'GET', path: '/v1/x', schema, idempotent: true }),
    ).rejects.toMatchObject({
      status: 409,
      upstreamCode: 'CONNECTOR_UNAVAILABLE',
      detail: 'ocupado',
    });
    expect(rejected.seen).toHaveLength(1);

    const crashed = client([() => json(500, {}), () => json(200, { ok: true })]);
    await expect(
      crashed.http.call({ method: 'GET', path: '/v1/x', schema, idempotent: true }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(crashed.seen).toHaveLength(1);
  });

  it('una respuesta 2xx fuera de contrato no se acepta', async () => {
    const { http } = client([() => json(200, { ok: 'sí' })]);
    await expect(
      http.call({ method: 'GET', path: '/v1/x', schema, idempotent: true }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('un 404 se informa como rechazo con su status', async () => {
    const { http } = client([
      () => json(404, { type: 't', title: 't', status: 404, code: 'SAGA_NOT_FOUND' }),
    ]);
    await expect(
      http.call({ method: 'GET', path: '/v1/x', schema, idempotent: true }),
    ).rejects.toBeInstanceOf(UpstreamRejectedError);
  });
});

describe('CognitoTokenVerifier', () => {
  const ISSUER = 'http://floci:4566/us-east-1_test';
  const CLIENT = 'client-123';

  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const verifier = new CognitoTokenVerifier({
      issuer: ISSUER,
      clientId: CLIENT,
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
    const sign = (
      claims: Record<string, unknown>,
      options: { issuer?: string; audience?: string; exp?: string } = {},
    ) =>
      new SignJWT({ token_use: 'id', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject('user-sub')
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? CLIENT)
        .setIssuedAt()
        .setExpirationTime(options.exp ?? '1h')
        .sign(privateKey);
    return { verifier, sign };
  }

  it('acepta un ID token válido y extrae grupos y flota de claims firmados', async () => {
    const { verifier, sign } = await setup();
    const token = await sign({
      'cognito:groups': ['fleet-operators'],
      'custom:fleet_id': 'fleet_alfa',
    });

    expect(await verifier.verify(token)).toEqual({
      subject: 'user-sub',
      groups: ['fleet-operators'],
      fleetId: 'fleet_alfa',
    });
  });

  it('rechaza tokens de otro ambiente (iss/aud), vencidos, access tokens o con otra firma', async () => {
    const { verifier, sign } = await setup();
    const other = await setup();
    const cases = [
      await sign({}, { issuer: 'http://floci:4566/us-east-1_prod' }),
      await sign({}, { audience: 'otro-client' }),
      await sign({}, { exp: '-10m' }),
      await sign({ token_use: 'access' }),
      await other.sign({}),
      'no-es-un-jwt',
    ];
    for (const token of cases) {
      await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
    }
  });
});
