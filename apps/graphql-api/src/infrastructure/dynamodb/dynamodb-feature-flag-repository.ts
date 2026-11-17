import { featureFlagsV1 } from '@aegisvolt/contracts';
import {
  definitionOf,
  featureFlagKeys,
  type FeatureFlagKey as CatalogKey,
} from '@aegisvolt/feature-flags';
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type {
  AuditedFlagChange,
  DeploymentEnvironment,
  FeatureFlagRepository,
} from '../../application/index.ts';
import { ActorId, FeatureFlag, FeatureFlagKey } from '../../domain/index.ts';
import { dynamo } from './errors.ts';

const AUDIT_PREFIX = 'AUDIT#';

/** Ítem de auditoría (mismo esquema que documenta `table.ts` de @aegisvolt/feature-flags). */
interface AuditItem {
  PK: string;
  SK: string;
  entity: 'FLAG_AUDIT';
  key: string;
  from: boolean;
  to: boolean;
  version: number;
  changedBy: string;
  changedAt: string;
  correlationId: string;
  environment: DeploymentEnvironment;
}

/**
 * Repositorio de flags de UNA tabla: la del ambiente del despliegue, fijada al
 * construirlo desde la configuración (`resolveFeatureFlagsTable`). Ningún método
 * acepta un nombre de tabla ni un ambiente.
 */
export class DynamoDbFeatureFlagRepository implements FeatureFlagRepository {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(db: DynamoDBDocumentClient, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  async findMany(keys: readonly FeatureFlagKey[]): Promise<readonly FeatureFlag[]> {
    if (keys.length === 0) {
      return [];
    }
    const result = await dynamo(() =>
      this.db.send(
        new BatchGetCommand({
          RequestItems: {
            [this.tableName]: {
              Keys: keys.map((key) => featureFlagKeys.flag(key as unknown as CatalogKey)),
              ConsistentRead: true,
            },
          },
        }),
      ),
    );
    const items = result.Responses?.[this.tableName] ?? [];
    return items.map((item) => toFlag(item));
  }

  async find(key: FeatureFlagKey): Promise<FeatureFlag | undefined> {
    const { Item } = await dynamo(() =>
      this.db.send(
        new GetCommand({
          TableName: this.tableName,
          Key: featureFlagKeys.flag(key as unknown as CatalogKey),
          ConsistentRead: true,
        }),
      ),
    );
    return Item === undefined ? undefined : toFlag(Item);
  }

  async saveChange(input: {
    flag: FeatureFlag;
    expectedVersion: number;
    change: AuditedFlagChange;
  }): Promise<void> {
    const { flag, change } = input;
    const pk = featureFlagKeys.flag(flag.key as unknown as CatalogKey);
    const audit: AuditItem = {
      PK: pk.PK,
      SK: `${AUDIT_PREFIX}${change.changedAt.toISOString()}#${String(change.version).padStart(8, '0')}`,
      entity: 'FLAG_AUDIT',
      key: change.key,
      from: change.from,
      to: change.to,
      version: change.version,
      changedBy: change.changedBy,
      changedAt: change.changedAt.toISOString(),
      correlationId: change.correlationId,
      environment: change.environment,
    };
    await dynamo(() =>
      this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...pk,
                  key: flag.key,
                  enabled: flag.enabled,
                  description: flag.description,
                  version: flag.version,
                  updatedAt: flag.updatedAt.toISOString(),
                  updatedBy: flag.updatedBy,
                },
                // Nadie la cambió desde la lectura (concurrencia optimista).
                ConditionExpression: 'version = :read',
                ExpressionAttributeValues: { ':read': input.expectedVersion },
              },
            },
            {
              // La auditoría se escribe en la misma transacción: no hay cambio sin registro.
              Put: {
                TableName: this.tableName,
                Item: audit,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      ),
    );
  }

  async listChanges(key: FeatureFlagKey, limit: number): Promise<readonly AuditedFlagChange[]> {
    const result = await dynamo(() =>
      this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :audit)',
          ExpressionAttributeValues: {
            ':pk': featureFlagKeys.flag(key as unknown as CatalogKey).PK,
            ':audit': AUDIT_PREFIX,
          },
          ScanIndexForward: false,
          Limit: limit,
          ConsistentRead: true,
        }),
      ),
    );
    return ((result.Items ?? []) as AuditItem[]).map((item) => ({
      key: FeatureFlagKey.parse(item.key),
      from: item.from,
      to: item.to,
      version: item.version,
      changedBy: ActorId.parse(item.changedBy),
      changedAt: new Date(item.changedAt),
      correlationId: item.correlationId,
      environment: item.environment,
    }));
  }
}

/** Valida el ítem con el contrato (solo booleanos) y lo reconstruye en el dominio. */
function toFlag(item: Record<string, unknown>): FeatureFlag {
  const state = featureFlagsV1.featureFlagStateSchema.parse(item);
  return FeatureFlag.restore({
    key: FeatureFlagKey.parse(state.key),
    enabled: state.enabled,
    // Ítems sembrados sin descripción: se usa la del catálogo.
    description: state.description ?? definitionOf(state.key).description,
    version: state.version,
    updatedBy: ActorId.parse(state.updatedBy),
    updatedAt: new Date(state.updatedAt),
  });
}
