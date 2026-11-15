import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLogger } from '@aegisvolt/logger';
import type { ApolloServer } from '@apollo/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      ...createBffUseCases(new FakeUpstreams().build(), 'dev'),
      getFeatureFlags: new GetFeatureFlags(deps),
      updateFeatureFlag: new UpdateFeatureFlag(deps),
    },
    tokens,
    readinessCheck: () => Promise.resolve(ready),
    logger,
    serviceVersion: 'sha-test-v1',
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

describe('logs estructurados (ADR-0028)', () => {
  const CORRELATION = '6c1f0b8e-2d3a-4b5c-9d7e-0123456789ab';
  const requestsOf = (correlationId: string) =>
    logLines.filter(
      (line) => line.event === 'http_request' && line.correlation_id === correlationId,
    );

  it('la operación GraphQL (con nombre o el campo raíz si es anónima) y el correlation_id quedan en el log', async () => {
    const named = await post(
      { query: 'query Flags { featureFlags { environment } }', operationName: 'Flags' },
      { authorization: 'Bearer valid-op', 'x-correlation-id': CORRELATION },
    );
    expect(named.status).toBe(200);
    const anonymousId = '7d2e1c9f-3e4b-4c6d-8e9f-123456789abc';
    await post(
      { query: '{ featureFlags { environment } }' },
      { authorization: 'Bearer valid-op', 'x-correlation-id': anonymousId },
    );

    await vi.waitFor(() => {
      expect(requestsOf(CORRELATION)).toHaveLength(1);
      expect(requestsOf(anonymousId)).toHaveLength(1);
    });
    expect(requestsOf(CORRELATION)[0]).toMatchObject({
      service_name: 'graphql-api',
      environment: 'test',
      operation: 'query.Flags',
      http_status: 200,
    });
    expect(requestsOf(anonymousId)[0]).toMatchObject({ operation: 'query.featureFlags' });
  });

  it('un token rechazado se registra por su motivo, nunca por su valor', async () => {
    const correlationId = '8e3f2d0a-4f5c-4d7e-9f0a-23456789abcd';
    await post(
      { query: '{ featureFlags { environment } }' },
      { authorization: 'Bearer tok-secreto-xyz', 'x-correlation-id': correlationId },
    );

    await vi.waitFor(() => {
      expect(requestsOf(correlationId)).toHaveLength(1);
    });
    const rejected = logLines.find(
      (line) => line.message === 'Token rechazado' && line.correlation_id === correlationId,
    );
    expect(rejected).toMatchObject({ level: 'warn', event: 'auth_rejected' });
    expect(JSON.stringify(logLines)).not.toContain('tok-secreto-xyz');
    expect(JSON.stringify(logLines)).not.toContain('valid-op');
  });
});

describe('versión y resultado de cada operación (canary, ADR-0032)', () => {
  it('cada respuesta identifica la versión que la atendió', async () => {
    const response = await post(
      { query: '{ featureFlags { environment } }' },
      { authorization: 'Bearer valid-op' },
    );
    expect(response.headers.get('x-service-version')).toBe('sha-test-v1');
    expect((await fetch(`${url}/health/live`)).headers.get('x-service-version')).toBe(
      'sha-test-v1',
    );
  });

  it('registra graphql_operation con el resultado: ok y client_error', async () => {
    const okId = '9f4a3e1b-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const badId = '0a5b4f2c-6b7c-4d8e-9f0a-1b2c3d4e5f60';
    await post(
      { query: '{ featureFlags { environment } }' },
      { authorization: 'Bearer valid-op', 'x-correlation-id': okId },
    );
    await post({ query: '{ featureFlags { environment } }' }, { 'x-correlation-id': badId }); // sin token

    const operation = (id: string) =>
      logLines.find((line) => line.event === 'graphql_operation' && line.correlation_id === id);
    await vi.waitFor(() => {
      expect(operation(okId)).toBeDefined();
      expect(operation(badId)).toBeDefined();
    });
    expect(operation(okId)).toMatchObject({
      outcome: 'ok',
      operation: 'query.featureFlags',
      level: 'info',
    });
    expect(operation(badId)).toMatchObject({
      outcome: 'client_error',
      error_codes: ['UNAUTHENTICATED'],
    });
  });
});
