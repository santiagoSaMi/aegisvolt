import {
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  FEATURE_FLAG_CATALOG,
  featureFlagKeys,
  featureFlagsTableDefinition,
  type FlagEnvironment,
} from '@aegisvolt/feature-flags';

import {
  createDynamoDbClients,
  type DynamoDbClients,
} from '../../src/infrastructure/aws/dynamodb-client.ts';

/**
 * Entorno de integración: DynamoDB de Floci (local). Nunca apunta a AWS real:
 * el endpoint debe ser local y las credenciales son las ficticias del emulador.
 */
export const FLOCI_ENDPOINT = process.env.INTEGRATION_AWS_ENDPOINT_URL ?? 'http://localhost:4566';

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(FLOCI_ENDPOINT)) {
  throw new Error(`INTEGRATION_AWS_ENDPOINT_URL debe ser local: ${FLOCI_ENDPOINT}`);
}
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_CONFIG_FILE = '/dev/null';
process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';

async function probe(): Promise<boolean> {
  try {
    const response = await fetch(`${FLOCI_ENDPOINT}/_floci/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const flociAvailable = await probe();

if (!flociAvailable && process.env.REQUIRE_INTEGRATION === 'true') {
  throw new Error(`Floci no responde en ${FLOCI_ENDPOINT} y REQUIRE_INTEGRATION=true`);
}

export function createClients(): DynamoDbClients {
  return createDynamoDbClients({
    region: 'us-east-1',
    endpointUrl: FLOCI_ENDPOINT,
    connectionTimeoutMs: 2_000,
    requestTimeoutMs: 5_000,
    maxAttempts: 2,
  });
}

/** Crea la tabla de flags de un ambiente y la siembra como lo hará Terraform. */
export async function createSeededFlagsTable(
  clients: DynamoDbClients,
  tableName: string,
  environment: FlagEnvironment,
): Promise<void> {
  await clients.client.send(new CreateTableCommand(featureFlagsTableDefinition(tableName)));
  await waitUntilTableExists({ client: clients.client, maxWaitTime: 30 }, { TableName: tableName });
  for (const definition of FEATURE_FLAG_CATALOG) {
    await clients.documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...featureFlagKeys.flag(definition.key),
          key: definition.key,
          enabled: definition.initial[environment],
          description: definition.description,
          version: 1,
          updatedAt: '2026-11-13T12:00:00.000Z',
          updatedBy: 'seed',
        },
      }),
    );
  }
}

export async function deleteTable(clients: DynamoDbClients, tableName: string): Promise<void> {
  await clients.client.send(new DeleteTableCommand({ TableName: tableName }));
}
