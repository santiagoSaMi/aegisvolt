import { Router } from 'express';

import { sendJson } from '../problem.ts';

/**
 * Probes de Kubernetes:
 * - `/health/live`: el proceso responde (no consulta dependencias).
 * - `/health/ready`: puede atender tráfico (la tabla DynamoDB está ACTIVE).
 */
export function healthRoutes(readinessCheck: () => Promise<boolean>): Router {
  const router = Router();

  router.get('/health/live', (_req, res) => {
    sendJson(res, 200, { status: 'ok' });
  });

  router.get('/health/ready', async (_req, res) => {
    const ready = await readinessCheck().catch(() => false);
    sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
  });

  return router;
}
