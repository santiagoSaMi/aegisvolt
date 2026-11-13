// Tarea controlada de recuperación: ejecuta UNA ronda de `RecoverPendingSagas`
// (o reintenta la compensación de una SAGA concreta) y termina. Pensada para un
// Job/CronJob de Kubernetes o para el operador. Usa la misma configuración que el servicio.
// Uso: pnpm --filter @aegisvolt/saga-orchestrator-service saga:recover [--retry <sagaId>]
import { createLogger } from '@aegisvolt/logger';

import { createUseCases } from '../src/composition.ts';
import { loadServiceConfig } from '../src/config.ts';
import { createDynamoDbClients } from '../src/infrastructure/aws/dynamodb-client.ts';
import { createHttpParticipants } from '../src/infrastructure/http/participants.ts';
import { LoggingSagaObserver } from '../src/infrastructure/observability/logging-saga-observer.ts';
import { RandomUuidGenerator, SystemClock, sleep } from '../src/infrastructure/system/system.ts';

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
  owner: `recovery-task:${String(process.pid)}`,
});

try {
  const retryIndex = process.argv.indexOf('--retry');
  if (retryIndex >= 0) {
    const sagaId = process.argv[retryIndex + 1] ?? '';
    const saga = await useCases.retryCompensation.execute(sagaId);
    logger.info('Reintento controlado terminado', { saga_id: saga.id, status: saga.status });
  } else {
    const report = await useCases.recoverPendingSagas.execute();
    logger.info('Recuperación terminada', { event: 'saga_recovery', ...report });
  }
} catch (error) {
  logger.error('Recuperación fallida', {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  process.exitCode = 1;
} finally {
  client.destroy();
}
