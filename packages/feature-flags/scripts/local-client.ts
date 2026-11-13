// Cliente DynamoDB para los scripts locales. Se niega a apuntar a algo que no
// sea Floci en localhost: estos scripts nunca tocan AWS real.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { featureFlagsTableName } from '../src/table.ts';

export function localClients(): {
  client: DynamoDBClient;
  documentClient: DynamoDBDocumentClient;
  endpointUrl: string;
} {
  const endpointUrl = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(endpointUrl)) {
    process.stderr.write('AWS_ENDPOINT_URL debe ser local (Floci). Abortando.\n');
    process.exit(1);
  }
  // Credenciales ficticias del emulador si no se definieron.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: endpointUrl,
    maxAttempts: 2,
  });
  return { client, documentClient: DynamoDBDocumentClient.from(client), endpointUrl };
}

/** `FEATURE_FLAGS_TABLE_NAME` o, si no está, `aegisvolt-feature-flags-<env>`. */
export function tableNameFor(environment: string): string {
  const explicit = process.env.FEATURE_FLAGS_TABLE_NAME;
  return explicit !== undefined && explicit !== '' ? explicit : featureFlagsTableName(environment);
}
