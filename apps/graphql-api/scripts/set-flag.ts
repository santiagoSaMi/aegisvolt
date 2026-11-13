// CLI de operador LOCAL: cambia una flag con el MISMO caso de uso que el
// graphql-api (`UpdateFeatureFlag`): autorización de administrador, versión
// condicional y auditoría. El ambiente es el de APP_ENV (como en un despliegue),
// y se niega a ejecutarse contra un endpoint que no sea Floci en localhost.
// Uso: APP_ENV=<env> node scripts/set-flag.ts <FLAG> <true|false> [--expected-version N]
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

import { ADMIN_GROUP } from '../src/application/index.ts';
import { createFlagUseCases } from '../src/composition.ts';
import { loadServiceConfig } from '../src/config.ts';
import { createDynamoDbClients } from '../src/infrastructure/aws/dynamodb-client.ts';
import { SystemClock } from '../src/infrastructure/system/system-clock.ts';

const endpointUrl = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(endpointUrl)) {
  process.stderr.write('AWS_ENDPOINT_URL debe ser local (Floci). Abortando.\n');
  process.exit(1);
}
process.env.AWS_ENDPOINT_URL = endpointUrl;
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const [key, value, flag, expected] = process.argv.slice(2);
if (key === undefined || (value !== 'true' && value !== 'false')) {
  process.stderr.write('Uso: set-flag.ts <FLAG> <true|false> [--expected-version N]\n');
  process.exit(2);
}

const config = loadServiceConfig(process.env);
const { client, documentClient } = createDynamoDbClients({
  region: config.aws.region,
  endpointUrl,
  connectionTimeoutMs: config.dynamodb.connectionTimeoutMs,
  requestTimeoutMs: config.dynamodb.requestTimeoutMs,
  maxAttempts: config.dynamodb.maxAttempts,
});
const useCases = createFlagUseCases({
  documentClient,
  tableName: config.featureFlags.tableName,
  environment: config.appEnv,
  cacheTtlMs: 0,
  clock: new SystemClock(),
});

try {
  // Operador local = administrador de la plataforma en este ambiente local.
  const result = await useCases.updateFeatureFlag.execute(
    { subject: `cli:${userInfo().username}`, groups: [ADMIN_GROUP] },
    {
      key,
      enabled: value === 'true',
      expectedVersion: flag === '--expected-version' ? Number(expected) : undefined,
      correlationId: randomUUID(),
    },
  );
  process.stdout.write(
    `${config.featureFlags.tableName}: ${key} = ${String(result.flag.enabled)} (v${String(result.flag.version)}${result.changed ? ', auditado' : ', sin cambios'})\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}
