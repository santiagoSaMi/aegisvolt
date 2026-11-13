import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import {
  ConcurrentModificationError,
  SagaAlreadyExistsError,
  type Lease,
  type SagaRepository,
  type Versioned,
} from '../../application/index.ts';
import {
  SAGA_STATUSES,
  TERMINAL_STATUSES,
  type FleetId,
  type SagaEvent,
  type SagaId,
  type SagaStatus,
  type SagaTransaction,
} from '../../domain/index.ts';
import { dynamo } from './errors.ts';
import {
  fromEventItem,
  fromSagaItem,
  toEventItem,
  toSagaItem,
  type SagaEventItem,
  type SagaItem,
} from './mappers.ts';
import { GSI1, GSI2, keys } from './table.ts';

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

const NON_TERMINAL_STATUSES = SAGA_STATUSES.filter(
  (status) => !(TERMINAL_STATUSES as readonly SagaStatus[]).includes(status),
);

/**
 * SAGAs y su historial en `aegisvolt-sagas-<env>`.
 *
 * - `create`: SAGA nueva (`attribute_not_exists`) + eventos, con el *lease* del creador.
 * - `save`: SAGA en la versión leída Y con el *lease* de quien escribe
 *   (`version = :v AND leaseOwner = :owner`) + eventos nuevos (`attribute_not_exists`).
 * - `acquireLease`: condicional; libre, vencido o ya propio.
 * Si una condición falla no se escribe nada (todo o nada).
 */
export class DynamoDbSagaRepository implements SagaRepository {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(db: DynamoDBDocumentClient, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  async create(saga: SagaTransaction, lease: Lease): Promise<void> {
    try {
      await this.transact([
        {
          Put: {
            TableName: this.tableName,
            Item: toSagaItem(saga, 1, lease),
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        ...this.eventPuts(saga),
      ]);
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        throw new SagaAlreadyExistsError(`La SAGA ${saga.id} ya existe`, { cause: error });
      }
      throw error;
    }
  }

  async find(sagaId: SagaId): Promise<Versioned<SagaTransaction> | undefined> {
    const { Item } = await dynamo(() =>
      this.db.send(
        new GetCommand({ TableName: this.tableName, Key: keys.saga(sagaId), ConsistentRead: true }),
      ),
    );
    if (Item === undefined) {
      return undefined;
    }
    const item = Item as SagaItem;
    return { value: fromSagaItem(item), version: item.version };
  }

  async save(saga: SagaTransaction, expectedVersion: number, lease: Lease): Promise<number> {
    const version = expectedVersion + 1;
    await this.transact([
      {
        Put: {
          TableName: this.tableName,
          Item: toSagaItem(saga, version, lease),
          ConditionExpression: 'version = :read AND leaseOwner = :owner',
          ExpressionAttributeValues: { ':read': expectedVersion, ':owner': lease.owner },
        },
      },
      ...this.eventPuts(saga),
    ]);
    return version;
  }

  async acquireLease(sagaId: SagaId, lease: Lease, now: Date): Promise<boolean> {
    try {
      await dynamo(() =>
        this.db.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: keys.saga(sagaId),
            UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :expires',
            ConditionExpression:
              'attribute_exists(PK) AND (attribute_not_exists(leaseOwner) OR leaseExpiresAt < :now OR leaseOwner = :owner)',
            ExpressionAttributeValues: {
              ':owner': lease.owner,
              ':expires': lease.expiresAt.toISOString(),
              ':now': now.toISOString(),
            },
          }),
        ),
      );
      return true;
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        return false;
      }
      throw error;
    }
  }

  async releaseLease(sagaId: SagaId, owner: string): Promise<void> {
    try {
      await dynamo(() =>
        this.db.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: keys.saga(sagaId),
            UpdateExpression: 'REMOVE leaseOwner, leaseExpiresAt',
            ConditionExpression: 'leaseOwner = :owner',
            ExpressionAttributeValues: { ':owner': owner },
          }),
        ),
      );
    } catch (error) {
      // Si ya no es nuestro (lo tomó otra réplica), no hay nada que liberar.
      if (!(error instanceof ConcurrentModificationError)) {
        throw error;
      }
    }
  }

  async listEvents(sagaId: SagaId): Promise<readonly SagaEvent[]> {
    const events: SagaEvent[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await dynamo(() =>
        this.db.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :evt)',
            ExpressionAttributeValues: {
              ':pk': keys.sagaPartition(sagaId),
              ':evt': keys.eventPrefix,
            },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          }),
        ),
      );
      events.push(...((page.Items ?? []) as SagaEventItem[]).map(fromEventItem));
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
    return events;
  }

  async listByFleet(
    fleetId: FleetId,
    query: { status?: SagaStatus | undefined; limit: number },
  ): Promise<readonly SagaTransaction[]> {
    const result = await dynamo(() =>
      this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1,
          KeyConditionExpression: 'GSI1PK = :pk',
          ...(query.status === undefined
            ? { ExpressionAttributeValues: { ':pk': keys.fleet(fleetId) } }
            : {
                FilterExpression: '#status = :status',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':pk': keys.fleet(fleetId), ':status': query.status },
              }),
          ScanIndexForward: false,
          Limit: query.limit,
        }),
      ),
    );
    return ((result.Items ?? []) as SagaItem[]).map(fromSagaItem);
  }

  async listNonTerminal(limit: number): Promise<readonly Versioned<SagaTransaction>[]> {
    const found: Versioned<SagaTransaction>[] = [];
    for (const status of NON_TERMINAL_STATUSES) {
      if (found.length >= limit) {
        break;
      }
      const result = await dynamo(() =>
        this.db.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: GSI2,
            KeyConditionExpression: 'GSI2PK = :pk',
            ExpressionAttributeValues: { ':pk': keys.status(status) },
            // Las más antiguas primero: son las que más tiempo llevan sin avanzar.
            ScanIndexForward: true,
            Limit: limit - found.length,
          }),
        ),
      );
      for (const item of (result.Items ?? []) as SagaItem[]) {
        found.push({ value: fromSagaItem(item), version: item.version });
      }
    }
    return found;
  }

  private eventPuts(saga: SagaTransaction): TransactItem[] {
    return saga.pendingEvents.map((event) => ({
      Put: {
        TableName: this.tableName,
        Item: toEventItem(saga, event),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    }));
  }

  private async transact(items: TransactItem[]): Promise<void> {
    await dynamo(() => this.db.send(new TransactWriteCommand({ TransactItems: items })));
  }
}
