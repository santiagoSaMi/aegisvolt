import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface DynamoDbClientConfig {
  readonly region: string;
  /**
   * Solo se define en entornos locales (Floci). En AWS real se omite y el SDK
   * usa el endpoint regional (vía VPC Endpoint de DynamoDB, ADR-0010).
   */
  readonly endpointUrl?: string;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
  /** Intentos totales del SDK (incluye el primero). Pocos: la SAGA ya reintenta (ADR-0004). */
  readonly maxAttempts: number;
}

export interface DynamoDbClients {
  readonly client: DynamoDBClient;
  readonly documentClient: DynamoDBDocumentClient;
}

/**
 * Cliente DynamoDB (AWS SDK v3) con timeouts explícitos. Las credenciales salen
 * de la cadena por defecto del SDK (variables de entorno, rol de pod…), nunca del código.
 */
export function createDynamoDbClients(config: DynamoDbClientConfig): DynamoDbClients {
  const client = new DynamoDBClient({
    region: config.region,
    maxAttempts: config.maxAttempts,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
    }),
    ...(config.endpointUrl === undefined ? {} : { endpoint: config.endpointUrl }),
  });
  const documentClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return { client, documentClient };
}
