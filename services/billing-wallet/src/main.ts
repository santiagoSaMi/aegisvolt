// Composition root: carga la configuración validada, crea los adaptadores y
// arranca el servidor HTTP con apagado ordenado.
import { createLogger } from '@aegisvolt/logger';

import { createUseCases } from './composition.ts';
import { SERVICE_NAME, loadServiceConfig } from './config.ts';
import { createDynamoDbClients } from './infrastructure/aws/dynamodb-client.ts';
import { SystemClock } from './infrastructure/clock/system-clock.ts';
import { createDynamoDbReadinessCheck } from './infrastructure/dynamodb/readiness.ts';
import { createFeatureFlagReader } from './infrastructure/feature-flags/feature-flag-reader.ts';
import { createHttpApp } from './presentation/http/app.ts';

function bootstrap(): void {
  const config = loadServiceConfig(process.env);
  const logger = createLogger({
    service: config.serviceName,
    environment: config.appEnv,
    version: config.serviceVersion,
    level: config.logLevel,
  });

  const { client, documentClient } = createDynamoDbClients({
    region: config.aws.region,
    connectionTimeoutMs: config.dynamodb.connectionTimeoutMs,
    requestTimeoutMs: config.dynamodb.requestTimeoutMs,
    maxAttempts: config.dynamodb.maxAttempts,
    ...(config.aws.endpointUrl === undefined ? {} : { endpointUrl: config.aws.endpointUrl }),
  });

  const app = createHttpApp({
    useCases: createUseCases({
      documentClient,
      tableName: config.dynamodb.tableName,
      clock: new SystemClock(),
      flags: createFeatureFlagReader({
        documentClient,
        tableName: config.featureFlags.tableName,
        cacheTtlMs: config.featureFlags.cacheTtlMs,
        logger,
      }),
      pricing: config.pricing,
    }),
    readinessCheck: createDynamoDbReadinessCheck(client, config.dynamodb.tableName),
    logger,
    requestTimeoutMs: config.http.requestTimeoutMs,
  });

  const server = app.listen(config.port, (error?: Error) => {
    // Express 5 entrega aquí los errores de `listen` (p. ej. EADDRINUSE): sin
    // esta comprobación el proceso terminaría con código 0 sin servir nada.
    if (error) {
      logger.fatal('No se pudo abrir el puerto HTTP', { port: config.port, error: error.message });
      process.exitCode = 1;
      client.destroy();
      return;
    }
    logger.info('Servicio iniciado', {
      port: config.port,
      table: config.dynamodb.tableName,
      flags_table: config.featureFlags.tableName,
      awsEndpoint: config.aws.endpointUrl ?? 'default',
    });
  });
  // Timeouts del servidor por encima del presupuesto por petición (que responde 503).
  server.requestTimeout = config.http.requestTimeoutMs + 5_000;
  server.headersTimeout = config.http.requestTimeoutMs + 5_000;
  server.keepAliveTimeout = 5_000;

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info('Apagado solicitado', { signal });
    server.close((error) => {
      client.destroy();
      if (error) {
        logger.error('Error al cerrar el servidor HTTP', { error: error.message });
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

try {
  bootstrap();
} catch (error) {
  createLogger({
    service: SERVICE_NAME,
    environment: process.env.APP_ENV ?? 'unknown',
    version: process.env.SERVICE_VERSION ?? 'unknown',
  }).fatal('Arranque fallido', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
