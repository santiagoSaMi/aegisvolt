// Crea la tabla del servicio en Floci para desarrollo local (idempotente).
// En los ambientes dev/test/prod la tabla la crea Terraform; este script se
// niega a ejecutarse contra un endpoint que no sea local.
import {
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

import { createDynamoDbClients } from '../src/infrastructure/aws/dynamodb-client.ts';
import { tableDefinition } from '../src/infrastructure/dynamodb/table.ts';

const endpointUrl = process.env.AWS_ENDPOINT_URL;
const tableName = process.env.DYNAMODB_TABLE_NAME;

if (
  endpointUrl === undefined ||
  !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(endpointUrl)
) {
  process.stderr.write('AWS_ENDPOINT_URL debe ser local (Floci). Abortando.\n');
  process.exit(1);
}
if (tableName === undefined || tableName === '') {
  process.stderr.write('Defina DYNAMODB_TABLE_NAME.\n');
  process.exit(1);
}

const { client } = createDynamoDbClients({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpointUrl,
  connectionTimeoutMs: 2_000,
  requestTimeoutMs: 5_000,
  maxAttempts: 2,
});

try {
  await client.send(new DescribeTableCommand({ TableName: tableName }));
  process.stdout.write(`La tabla ${tableName} ya existe.\n`);
} catch (error) {
  if ((error as { name?: string }).name !== 'ResourceNotFoundException') {
    throw error;
  }
  await client.send(new CreateTableCommand(tableDefinition(tableName)));
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  process.stdout.write(`Tabla ${tableName} creada en ${endpointUrl}.\n`);
} finally {
  client.destroy();
}
