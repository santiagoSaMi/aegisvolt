// Crea la tabla de flags de un ambiente en Floci (idempotente) y siembra las
// tres flags en `false` si no existen. En dev/test/prod lo hace Terraform.
// Uso: pnpm --filter @aegisvolt/feature-flags flags:create-local-table [env=local]
import {
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { featureFlagsV1 } from '@aegisvolt/contracts';

import { featureFlagKeys, featureFlagsTableDefinition } from '../src/table.ts';
import { localClients, tableNameFor } from './local-client.ts';

const environment = process.argv[2] ?? 'local';
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
  for (const key of featureFlagsV1.FEATURE_FLAG_KEYS) {
    try {
      await documentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...featureFlagKeys.flag(key),
            key,
            enabled: false,
            version: 1,
            updatedAt: now,
            updatedBy: 'seed',
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      process.stdout.write(`  ${key} = false (sembrada)\n`);
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw error;
      }
      process.stdout.write(`  ${key} ya existe (sin cambios)\n`);
    }
  }
} finally {
  client.destroy();
}
