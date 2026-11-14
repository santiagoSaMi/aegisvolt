import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLogger } from '@aegisvolt/logger';
import type { ApolloServer } from '@apollo/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FlagSnapshotCache,
  GetFeatureFlags,
  OPERATOR_GROUP,
  UnauthorizedError,
  UpdateFeatureFlag,
  type TokenVerifier,
} from '../../src/application/index.ts';
import { createBffUseCases } from '../../src/composition.ts';
import type { GraphqlContext } from '../../src/presentation/graphql/resolvers.ts';
import { createGraphqlServer } from '../../src/presentation/graphql/server.ts';
import { createHttpApp } from '../../src/presentation/http/app.ts';
import { FLEET, FakeUpstreams } from '../support/fake-upstreams.ts';
import {
  FixedClock,
  InMemoryFeatureFlagRepository,
} from '../support/in-memory-feature-flag-repository.ts';

const logLines: Record<string, unknown>[] = [];
const logger = createLogger({
  service: 'graphql-api',
  environment: 'test',
  version: 'test',
  destination: {
    write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>),
  },
});

/** Verificador falso: "valid-op" es un operador de FLEET; cualquier otro token es inválido. */
const tokens: TokenVerifier = {
  verify: (token) =>
    token === 'valid-op'
      ? Promise.resolve({ subject: 'op-sub', groups: [OPERATOR_GROUP], fleetId: FLEET })
      : Promise.reject(
          new UnauthorizedError('firma inválida', {
            cause: new Error('JWSSignatureVerificationFailed'),
          }),
        ),
};

let graphql: ApolloServer<GraphqlContext>;
let server: Server;
let url: string;
let ready = true;

beforeEach(async () => {
  graphql = createGraphqlServer({ logger, introspection: true, maxDepth: 8 });
  await graphql.start();
  const clock = new FixedClock(new Date('2026-11-13T15:00:00.000Z'));
  const flags = InMemoryFeatureFlagRepository.seeded('dev', clock.now());
  const deps = {
    flags,
    cache: new FlagSnapshotCache({ ttlMs: 0, clock }),
    clock,
    environment: 'dev' as const,
  };
  const app = createHttpApp({
    graphql,
    useCases: {
      ...createBffUseCases(new FakeUpstreams().build()),
      getFeatureFlags: new GetFeatureFlags(deps),
      updateFeatureFlag: new UpdateFeatureFlag(deps),
    },
    tokens,
    readinessCheck: () => Promise.resolve(ready),
    logger,
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  server.close();
  await graphql.stop();
  ready = true;
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('HTTP /graphql', () => {
  it('con un token válido responde datos y devuelve el correlation_id recibido', async () => {
    const correlationId = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
    const response = await post(
      { query: '{ walletBalance { fleetId } }' },
      { authorization: 'Bearer valid-op', 'x-correlation-id': correlationId },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
    expect(await response.json()).toEqual({ data: { walletBalance: { fleetId: FLEET } } });
  });

  it('crea un correlation_id cuando no llega uno válido', async () => {
    const response = await post(
      { query: '{ walletBalance { fleetId } }' },
      { authorization: 'Bearer valid-op', 'x-correlation-id': 'no-es-uuid' },
    );
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('token inválido → UNAUTHENTICATED, sin registrar el token', async () => {
    const response = await post(
      { query: '{ walletBalance { fleetId } }' },
      { authorization: 'Bearer eyJ.forjado.token' },
    );
    const body = (await response.json()) as { errors: { extensions: { code: string } }[] };

    expect(body.errors[0]?.extensions.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(logLines)).not.toContain('eyJ.forjado.token');
    expect(logLines).toContainEqual(expect.objectContaining({ event: 'auth_rejected' }));
  });

  it('protección CSRF: rechaza peticiones "simples" sin Content-Type JSON', async () => {
    const response = await fetch(
      `${url}/graphql?query=${encodeURIComponent('{ featureFlags { degraded } }')}`,
    );
    expect(response.status).toBe(400);
  });

  it('el cuerpo tiene un límite de tamaño', async () => {
    const response = await post({ query: `{ featureFlags { degraded } } # ${'x'.repeat(70_000)}` });
    expect(response.status).toBe(413);
  });
});

describe('probes', () => {
  it('liveness y readiness', async () => {
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
  });
});
