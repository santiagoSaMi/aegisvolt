// Composition root: carga la configuración validada, crea los adaptadores,
// arranca el servidor HTTP y el worker de recuperación, con apagado ordenado.
import { createLogger } from '@aegisvolt/logger';

import { createUseCases } from './composition.ts';
import { SERVICE_NAME, loadServiceConfig } from './config.ts';
import { createDynamoDbClients } from './infrastructure/aws/dynamodb-client.ts';
import { createDynamoDbReadinessCheck } from './infrastructure/dynamodb/readiness.ts';
import { createHttpParticipants } from './infrastructure/http/participants.ts';
import { LoggingSagaObserver } from './infrastructure/observability/logging-saga-observer.ts';
import { RecoveryWorker } from './infrastructure/process/recovery-worker.ts';
import { RandomUuidGenerator, SystemClock, sleep } from './infrastructure/system/system.ts';
import { createHttpApp } from './presentation/http/app.ts';
import { ReadinessGate, createGracefulShutdown } from './presentation/http/graceful-shutdown.ts';

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

  const useCases = createUseCases({
    documentClient,
    tableName: config.dynamodb.tableName,
    participants: createHttpParticipants(config.participants),
    clock: new SystemClock(),
    ids: new RandomUuidGenerator(),
    sleep,
    random: Math.random,
    observer: new LoggingSagaObserver(logger),
    saga: config.saga,
    recovery: config.recovery,
  });
  const readiness = new ReadinessGate(
    createDynamoDbReadinessCheck(client, config.dynamodb.tableName),
  );
  const app = createHttpApp({
    useCases,
    readinessCheck: readiness.check,
    logger,
    requestTimeoutMs: config.http.requestTimeoutMs,
    syncWaitMs: config.saga.syncWaitMs,
  });

  const worker = config.recovery.enabled
    ? new RecoveryWorker({
        recover: useCases.recoverPendingSagas,
        logger,
        intervalMs: config.recovery.intervalMs,
      })
    : undefined;

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
      recovery: config.recovery.enabled ? `cada ${String(config.recovery.intervalMs)} ms` : 'off',
      awsEndpoint: config.aws.endpointUrl ?? 'default',
    });
    // Al arrancar, retoma las SAGAs que un proceso anterior dejó a medias.
    worker?.start();
  });
  server.requestTimeout = config.http.requestTimeoutMs + 5_000;
  server.headersTimeout = config.http.requestTimeoutMs + 5_000;
  server.keepAliveTimeout = 5_000;

  const shutdown = createGracefulShutdown({
    server,
    readiness,
    logger,
    drainDelayMs: config.shutdown.drainDelayMs,
    graceMs: config.shutdown.graceMs,
    onClosed: async () => {
      await worker?.stop();
      client.destroy();
    },
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
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
