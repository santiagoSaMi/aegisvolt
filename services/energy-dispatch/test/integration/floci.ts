import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

import {
  createDynamoDbClients,
  type DynamoDbClients,
} from '../../src/infrastructure/aws/dynamodb-client.ts';
import { featureFlagKeys, featureFlagsTableDefinition } from '@aegisvolt/feature-flags';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

import { tableDefinition } from '../../src/infrastructure/dynamodb/table.ts';

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

async function createTable(
  clients: DynamoDbClients,
  definition: ReturnType<typeof tableDefinition>,
): Promise<string> {
  const tableName = definition.TableName ?? '';
  await clients.client.send(new CreateTableCommand(definition));
  await waitUntilTableExists({ client: clients.client, maxWaitTime: 30 }, { TableName: tableName });
  return tableName;
}

/** Crea una tabla temporal con el esquema del servicio y devuelve su nombre. */
export function createTemporaryTable(clients: DynamoDbClients): Promise<string> {
  return createTable(clients, tableDefinition(`aegisvolt-dispatch-it-${randomUUID().slice(0, 8)}`));
}

/** Tabla temporal de flags con el esquema de ADR-0007 (la del ambiente, en pequeño). */
export function createTemporaryFlagsTable(clients: DynamoDbClients): Promise<string> {
  return createTable(
    clients,
    featureFlagsTableDefinition(`aegisvolt-feature-flags-it-${randomUUID().slice(0, 8)}`),
  );
}

/** Escribe el estado de una flag tal como lo haría el GraphQL API (contrato featureFlagsV1). */
export async function setFlag(
  clients: DynamoDbClients,
  tableName: string,
  key: 'SIMULATE_CHARGER_HARDWARE_FAULT',
  enabled: boolean,
  version: number,
): Promise<void> {
  await clients.documentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...featureFlagKeys.flag(key),
        key,
        enabled,
        version,
        updatedAt: new Date().toISOString(),
        updatedBy: 'integration-test',
      },
    }),
  );
}

export async function deleteTable(clients: DynamoDbClients, tableName: string): Promise<void> {
  await clients.client.send(new DeleteTableCommand({ TableName: tableName }));
}
