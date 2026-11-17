import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { describe, expect, it } from 'vitest';

import {
  ReadinessGate,
  createGracefulShutdown,
} from '../../src/presentation/http/graceful-shutdown.ts';
import { capturingLogger } from '../support/fixtures.ts';

/** Servidor con una ruta lenta (petición en curso) y readiness a través del gate. */
async function startServer(slowMs: number) {
  const readiness = new ReadinessGate(() => Promise.resolve(true));
  const app = express();
  app.get('/health/ready', async (_req, res) => {
    res.status((await readiness.check()) ? 200 : 503).end();
  });
  app.get('/slow', (_req, res) => {
    setTimeout(() => res.json({ done: true }), slowMs);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, readiness, url };
}

describe('apagado ordenado', () => {
  it('readiness 503 al drenar, termina la petición en curso, rechaza nuevas y libera recursos', async () => {
    const { server, readiness, url } = await startServer(300);
    const { logger, lines } = capturingLogger();
    let released = false;
    const shutdown = createGracefulShutdown({
      server,
      readiness,
      logger,
      drainDelayMs: 150,
      graceMs: 2_000,
      onClosed: () => {
        released = true;
      },
    });

    const inFlight = fetch(`${url}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const done = shutdown('SIGTERM');

    // Durante el drenado el pod sigue aceptando conexiones pero no está listo.
    expect((await fetch(`${url}/health/ready`, { headers: { connection: 'close' } })).status).toBe(
      503,
    );
    expect(await (await inFlight).json()).toEqual({ done: true });
    await done;

    expect(server.listening).toBe(false);
    await expect(fetch(`${url}/health/ready`)).rejects.toThrow();
    expect(released).toBe(true);
    expect(lines.map((line) => line.message)).toEqual(['Apagado solicitado', 'Servicio detenido']);
    // Una segunda señal no repite el apagado.
    await shutdown('SIGINT');
    expect(lines).toHaveLength(2);
  });

  it('si las peticiones superan el plazo, corta las conexiones', async () => {
    const { server, readiness, url } = await startServer(10_000);
    const { logger, lines } = capturingLogger();
    const shutdown = createGracefulShutdown({
      server,
      readiness,
      logger,
      drainDelayMs: 0,
      graceMs: 200,
    });

    const stuck = fetch(`${url}/slow`).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startedAt = Date.now();
    await shutdown('SIGTERM');

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await stuck).toBeInstanceOf(Error);
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });
});
