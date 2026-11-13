import { stationReservationV1 } from '@aegisvolt/contracts';
import { describe, expect, it } from 'vitest';

import type { CallContext } from '../../src/application/index.ts';
import type { SagaId } from '../../src/domain/index.ts';
import { ServiceHttpClient } from '../../src/infrastructure/http/service-http-client.ts';

const ctx = (idempotencyKey = 'res_x'): CallContext =>
  ({
    sagaId: 'saga_00000000-0000-4000-8000-000000000001' as SagaId,
    correlationId: '3f2c1e5a-1b2c-4d3e-8f90-123456789abc',
    idempotencyKey,
  }) as CallContext;

function clientReturning(response: () => Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new ServiceHttpClient({
    baseUrl: 'http://station:4101',
    timeoutMs: 50,
    fetch: (url, init) => {
      requests.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
      return response();
    },
  });
  return { client, requests };
}

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const call = (client: ServiceHttpClient, key?: string) =>
  client.call({
    method: 'POST',
    path: '/v1/reservations/res_x/release',
    body: { reason: 'INSUFFICIENT_FUNDS' },
    ctx: ctx(key),
    schema: stationReservationV1.releaseReservationResponseSchema,
  });

describe('ServiceHttpClient', () => {
  it('propaga x-correlation-id, x-saga-id e idempotency-key (si es UUID)', async () => {
    const { client, requests } = clientReturning(() =>
      json(200, { reservationId: 'res_x', status: 'RELEASED', outcome: 'RELEASED' }),
    );

    const outcome = await call(client, '9b1d0c2e-4a5f-4c6d-8e7f-0123456789ab');

    expect(outcome).toMatchObject({ kind: 'OK', value: { outcome: 'RELEASED' } });
    expect(requests[0]?.init.headers).toMatchObject({
      'x-correlation-id': '3f2c1e5a-1b2c-4d3e-8f90-123456789abc',
      'x-saga-id': 'saga_00000000-0000-4000-8000-000000000001',
      'idempotency-key': '9b1d0c2e-4a5f-4c6d-8e7f-0123456789ab',
    });
  });

  it('4xx de negocio → REJECTED con el code del problem+json (no se reintenta)', async () => {
    const { client } = clientReturning(() =>
      json(409, { type: 't', title: 't', status: 409, code: 'RESERVATION_MISMATCH' }),
    );
    expect(await call(client)).toEqual({ kind: 'REJECTED', code: 'RESERVATION_MISMATCH' });
  });

  it('5xx, 429 y 408 → TRANSIENT (reintentable)', async () => {
    for (const status of [503, 500, 429, 408]) {
      const { client } = clientReturning(() => json(status, {}));
      expect((await call(client)).kind).toBe('TRANSIENT');
    }
  });

  it('timeout y error de red → TRANSIENT con su código', async () => {
    const slow = clientReturning(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => {
            reject(new DOMException('timeout', 'TimeoutError'));
          }, 60);
        }),
    );
    expect(await call(slow.client)).toMatchObject({ kind: 'TRANSIENT', code: 'TIMEOUT' });

    const down = clientReturning(() => Promise.reject(new TypeError('fetch failed')));
    expect(await call(down.client)).toMatchObject({ kind: 'TRANSIENT', code: 'NETWORK_ERROR' });
  });

  it('una respuesta 2xx que no cumple el contrato no confirma nada', async () => {
    const { client } = clientReturning(() => json(200, { ok: true }));
    expect(await call(client)).toMatchObject({ kind: 'REJECTED', code: 'UNEXPECTED_RESPONSE' });
  });
});
