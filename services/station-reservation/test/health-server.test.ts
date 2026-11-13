import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createHealthServer,
  type HealthServerOptions,
} from '../src/interfaces/http/health-server.ts';

let server: Server | undefined;

async function start(options?: HealthServerOptions): Promise<string> {
  server = createHealthServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server?.listening) {
    server.close();
    await once(server, 'close');
  }
});

describe('health server', () => {
  it('responde liveness', async () => {
    const response = await fetch(`${await start()}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('responde readiness según la verificación inyectada', async () => {
    const ready = await fetch(`${await start()}/health/ready`);
    expect(ready.status).toBe(200);

    server?.close();
    const notReady = await fetch(
      `${await start({ readinessCheck: () => Promise.resolve(false) })}/health/ready`,
    );
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: 'not_ready' });
  });

  it('trata un fallo de la verificación como no listo', async () => {
    const url = await start({ readinessCheck: () => Promise.reject(new Error('DynamoDB caído')) });

    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
  });

  it('responde 404 en formato problem+json', async () => {
    const response = await fetch(`${await start()}/no-existe`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toMatchObject({ status: 404, code: 'ROUTE_NOT_FOUND' });
  });
});
