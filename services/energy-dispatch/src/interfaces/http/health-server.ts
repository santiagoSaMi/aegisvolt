import { createServer, type Server, type ServerResponse } from 'node:http';

import { PROBLEM_JSON_CONTENT_TYPE, type ProblemDetails } from '@aegisvolt/contracts';

/** Devuelve `true` si las dependencias (DynamoDB, flags…) están disponibles. */
export type ReadinessCheck = () => Promise<boolean>;

export interface HealthServerOptions {
  readonly readinessCheck?: ReadinessCheck;
}

/**
 * Servidor HTTP mínimo con las probes de Kubernetes (`/health/live`, `/health/ready`).
 * Es provisional: se reemplazará por el framework HTTP que se fije en un ADR
 * cuando se implementen los endpoints del servicio.
 */
export function createHealthServer(options: HealthServerOptions = {}): Server {
  const readinessCheck = options.readinessCheck ?? (() => Promise.resolve(true));

  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'GET' && path === '/health/live') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && path === '/health/ready') {
      void readinessCheck().then(
        (ready) => {
          sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
        },
        () => {
          sendJson(response, 503, { status: 'not_ready' });
        },
      );
      return;
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'ROUTE_NOT_FOUND',
    };
    sendJson(response, problem.status, problem, PROBLEM_JSON_CONTENT_TYPE);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  contentType = 'application/json',
): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(JSON.stringify(body));
}
