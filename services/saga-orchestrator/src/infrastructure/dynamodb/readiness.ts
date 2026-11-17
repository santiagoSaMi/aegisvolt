import { DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';

/**
 * Readiness: la tabla del servicio existe y está ACTIVE. Se usa en
 * `GET /health/ready`; el resultado se cachea brevemente para que las probes
 * de Kubernetes no generen una llamada a DynamoDB por segundo.
 */
export function createDynamoDbReadinessCheck(
  client: DynamoDBClient,
  tableName: string,
  cacheMs = 2_000,
): () => Promise<boolean> {
  let cached: { ready: boolean; at: number } | undefined;
  return async () => {
    const now = Date.now();
    if (cached !== undefined && now - cached.at < cacheMs) {
      return cached.ready;
    }
    const ready = await client.send(new DescribeTableCommand({ TableName: tableName })).then(
      ({ Table }) => Table?.TableStatus === 'ACTIVE',
      () => false,
    );
    cached = { ready, at: now };
    return ready;
  };
}
