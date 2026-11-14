// Composition root del graphql-api: configuración validada, adaptadores
// (servicios por HTTP, flags en su tabla, verificador de Cognito), Apollo sobre
// Express y apagado ordenado.
import { createLogger } from '@aegisvolt/logger';

import { createBffUseCases, createFlagUseCases } from './composition.ts';
import { SERVICE_NAME, loadServiceConfig } from './config.ts';
import { CognitoTokenVerifier } from './infrastructure/auth/cognito-token-verifier.ts';
import { createDynamoDbClients } from './infrastructure/aws/dynamodb-client.ts';
import { createDynamoDbReadinessCheck } from './infrastructure/dynamodb/readiness.ts';
import { createUpstreams } from './infrastructure/http/gateways.ts';
import { SystemClock } from './infrastructure/system/system-clock.ts';
import { createGraphqlServer } from './presentation/graphql/server.ts';
import { createHttpApp } from './presentation/http/app.ts';
import { ReadinessGate, createGracefulShutdown } from './presentation/http/graceful-shutdown.ts';

async function bootstrap(): Promise<void> {
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
  const flags = createFlagUseCases({
    documentClient,
    tableName: config.featureFlags.tableName,
    environment: config.appEnv,
    cacheTtlMs: config.featureFlags.cacheTtlMs,
    clock: new SystemClock(),
  });
  const graphql = createGraphqlServer({
    logger,
    introspection: config.graphql.introspection,
    maxDepth: config.graphql.maxDepth,
  });
  await graphql.start();

  // Readiness: solo dependencias PROPIAS (tabla de flags). Los servicios internos
  // no se incluyen para no propagar en cascada la caída de uno de ellos.
  const readiness = new ReadinessGate(
    createDynamoDbReadinessCheck(client, config.featureFlags.tableName),
  );
  const app = createHttpApp({
    graphql,
    useCases: {
      ...createBffUseCases(createUpstreams(config.upstreams), config.appEnv),
      getFeatureFlags: flags.getFeatureFlags,
      updateFeatureFlag: flags.updateFeatureFlag,
    },
    tokens: new CognitoTokenVerifier(config.cognito),
    readinessCheck: readiness.check,
    logger,
  });

  const server = app.listen(config.port, (error?: Error) => {
    if (error) {
      logger.fatal('No se pudo abrir el puerto HTTP', { port: config.port, error: error.message });
      process.exitCode = 1;
      client.destroy();
      return;
    }
    logger.info('Servicio iniciado', {
      port: config.port,
      flags_table: config.featureFlags.tableName,
      introspection: config.graphql.introspection,
      cognito_issuer: config.cognito.issuer,
    });
  });
  server.requestTimeout = config.upstreams.sagaStartTimeoutMs + 5_000;
  server.headersTimeout = config.upstreams.sagaStartTimeoutMs + 5_000;
  server.keepAliveTimeout = 5_000;

  const shutdown = createGracefulShutdown({
    server,
    readiness,
    logger,
    drainDelayMs: config.shutdown.drainDelayMs,
    graceMs: config.shutdown.graceMs,
    onClosed: async () => {
      await graphql.stop();
      client.destroy();
    },
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

bootstrap().catch((error: unknown) => {
  createLogger({
    service: SERVICE_NAME,
    environment: process.env.APP_ENV ?? 'unknown',
    version: process.env.SERVICE_VERSION ?? 'unknown',
  }).fatal('Arranque fallido', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
