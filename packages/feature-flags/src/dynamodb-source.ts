import { featureFlagsV1 } from '@aegisvolt/contracts';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  InvalidFeatureFlagError,
  type FeatureFlagKey,
  type FeatureFlagSource,
  type FeatureFlagState,
} from './reader.ts';
import { featureFlagKeys } from './table.ts';

/**
 * Lee una flag de `aegisvolt-feature-flags-<env>` y valida el ítem con el
 * contrato `featureFlagsV1`. Solo lectura: el servicio no puede cambiar flags.
 * Usa lectura consistente: tras un cambio, la siguiente recarga de la caché lo ve.
 */
export class DynamoDbFeatureFlagSource implements FeatureFlagSource {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(db: DynamoDBDocumentClient, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  async fetch(key: FeatureFlagKey): Promise<FeatureFlagState | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: featureFlagKeys.flag(key),
        ConsistentRead: true,
        ProjectionExpression: '#key, enabled, version, updatedAt, updatedBy',
        ExpressionAttributeNames: { '#key': 'key' },
      }),
    );
    if (Item === undefined) {
      return undefined;
    }
    const parsed = featureFlagsV1.featureFlagStateSchema.safeParse(Item);
    if (!parsed.success || parsed.data.key !== key) {
      throw new InvalidFeatureFlagError(`El ítem de la flag ${key} no cumple el contrato`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
