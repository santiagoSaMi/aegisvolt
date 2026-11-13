import type { Logger } from '@aegisvolt/logger';
import express, { type Express } from 'express';

import { correlation } from './middleware/correlation.ts';
import { errorHandler } from './middleware/error-handler.ts';
import { requestLogger } from './middleware/request-logger.ts';
import { requestTimeout } from './middleware/request-timeout.ts';
import { buildProblem, sendProblem } from './problem.ts';
import { debitRoutes, type DebitUseCases } from './routes/debits.ts';
import { healthRoutes } from './routes/health.ts';
import { walletRoutes, type WalletUseCases } from './routes/wallets.ts';

export interface HttpAppDependencies {
  readonly useCases: WalletUseCases & DebitUseCases;
  readonly readinessCheck: () => Promise<boolean>;
  readonly logger: Logger;
  /** Presupuesto por petición (ADR-0004); al agotarse responde 503. */
  readonly requestTimeoutMs: number;
}

/** Construye la app Express (sin escuchar): se usa en main.ts y en las pruebas. */
export function createHttpApp(deps: HttpAppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(correlation());
  app.use(requestLogger(deps.logger));
  app.use(healthRoutes(deps.readinessCheck));
  app.use(requestTimeout(deps.requestTimeoutMs));
  app.use(express.json({ limit: '16kb' }));
  app.use(walletRoutes(deps.useCases));
  app.use(debitRoutes(deps.useCases));

  app.use((req, res) => {
    sendProblem(
      res,
      buildProblem({
        code: 'ROUTE_NOT_FOUND',
        detail: `${req.method} ${req.path}`,
        instance: req.originalUrl,
      }),
    );
  });
  app.use(errorHandler(deps.logger));
  return app;
}
