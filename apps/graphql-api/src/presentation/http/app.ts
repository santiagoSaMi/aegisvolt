import { expressMiddleware } from '@as-integrations/express5';
import type { ApolloServer } from '@apollo/server';
import type { Logger } from '@aegisvolt/logger';
import express, { Router, type Express, type Request } from 'express';

import type { Principal, TokenVerifier } from '../../application/index.ts';
import type { GraphqlContext, GraphqlUseCases } from '../graphql/resolvers.ts';
import { correlation } from './middleware/correlation.ts';
import { requestLogger } from './middleware/request-logger.ts';

export interface HttpAppDependencies {
  readonly graphql: ApolloServer<GraphqlContext>;
  readonly useCases: GraphqlUseCases;
  readonly tokens: TokenVerifier;
  readonly readinessCheck: () => Promise<boolean>;
  readonly logger: Logger;
}

/**
 * Identidad de la petición: `Authorization: Bearer <ID token>` verificado. Sin
 * token o con un token inválido → sin identidad (los casos de uso responden
 * UNAUTHENTICATED). Nunca se registra el token.
 */
async function principalOf(
  req: Request,
  tokens: TokenVerifier,
  logger: Logger,
): Promise<Principal | undefined> {
  const header = req.get('authorization');
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (match?.[1] === undefined) {
    logger.warn('Cabecera Authorization mal formada', { event: 'auth_rejected' });
    return undefined;
  }
  try {
    return await tokens.verify(match[1]);
  } catch (error) {
    logger.warn('Token rechazado', {
      event: 'auth_rejected',
      reason: error instanceof Error && error.cause instanceof Error ? error.cause.name : 'invalid',
    });
    return undefined;
  }
}

function healthRoutes(readinessCheck: () => Promise<boolean>): Router {
  const router = Router();
  router.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  router.get('/health/ready', async (_req, res) => {
    const ready = await readinessCheck().catch(() => false);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });
  return router;
}

/**
 * App HTTP del BFF: correlation id (se crea si no llega uno válido y se devuelve
 * en `x-correlation-id`), log por petición, probes y `/graphql`. Requiere
 * `graphql.start()` antes de atender peticiones.
 */
export function createHttpApp(deps: HttpAppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlation());
  app.use(requestLogger(deps.logger));
  app.use(healthRoutes(deps.readinessCheck));
  app.use(
    '/graphql',
    express.json({ limit: '64kb' }),
    expressMiddleware(deps.graphql, {
      context: async ({ req }): Promise<GraphqlContext> => ({
        principal: await principalOf(req, deps.tokens, deps.logger),
        useCases: deps.useCases,
      }),
    }),
  );
  app.use((_req, res) => {
    res.status(404).json({ code: 'ROUTE_NOT_FOUND' });
  });
  return app;
}
