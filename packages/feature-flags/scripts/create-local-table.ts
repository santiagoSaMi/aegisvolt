// Crea la tabla de flags de un ambiente en Floci (idempotente) y siembra cada
// flag del catálogo con el valor inicial de ESE ambiente si aún no existe.
// En dev/test/prod lo hace Terraform con los mismos valores (ADR-0025).
// Uso: pnpm --filter @aegisvolt/feature-flags flags:create-local-table [local|dev|test|prod]
import {
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

import { FEATURE_FLAG_CATALOG, FLAG_ENVIRONMENTS, type FlagEnvironment } from '../src/catalog.ts';
import { featureFlagKeys, featureFlagsTableDefinition } from '../src/table.ts';
import { localClients, tableNameFor } from './local-client.ts';

const environment = (process.argv[2] ?? 'local') as FlagEnvironment;
if (!FLAG_ENVIRONMENTS.includes(environment)) {
  process.stderr.write(`Ambiente inválido: ${environment} (${FLAG_ENVIRONMENTS.join('|')})\n`);
  process.exit(2);
}
const tableName = tableNameFor(environment);
const { client, documentClient, endpointUrl } = localClients();

try {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    process.stdout.write(`La tabla ${tableName} ya existe.\n`);
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceNotFoundException') {
      throw error;
    }
    await client.send(new CreateTableCommand(featureFlagsTableDefinition(tableName)));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
    process.stdout.write(`Tabla ${tableName} creada en ${endpointUrl}.\n`);
  }
  const now = new Date().toISOString();
  for (const definition of FEATURE_FLAG_CATALOG) {
    const enabled = definition.initial[environment];
    try {
      await documentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...featureFlagKeys.flag(definition.key),
            key: definition.key,
            enabled,
            description: definition.description,
            version: 1,
            updatedAt: now,
            updatedBy: 'seed',
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      process.stdout.write(`  ${definition.key} = ${String(enabled)} (sembrada)\n`);
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw error;
      }
      process.stdout.write(`  ${definition.key} ya existe (sin cambios)\n`);
    }
  }
} finally {
  client.destroy();
}
