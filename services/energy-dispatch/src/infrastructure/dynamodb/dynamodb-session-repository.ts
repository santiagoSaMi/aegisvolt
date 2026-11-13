import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import {
  InvalidCursorError,
  type SessionPage,
  type SessionRepository,
  type StoredSession,
} from '../../application/index.ts';
import type {
  ChargingSession,
  ConnectorId,
  SessionId,
  SessionTombstone,
  StationId,
  TelemetryRecord,
} from '../../domain/index.ts';
import { dynamo } from './errors.ts';
import {
  fromSessionItem,
  fromTelemetryItem,
  fromTombstoneItem,
  toSessionItem,
  toTelemetryItem,
  toTombstoneItem,
  type SessionItem,
  type SessionTombstoneItem,
  type TelemetryItem,
} from './mappers.ts';
import { ENTITY, GSI1, GSI2, keys } from './table.ts';

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

const NEW_ITEM = 'attribute_not_exists(PK)';

/**
 * Sesiones, ocupación de conectores y telemetría en `aegisvolt-dispatch-<env>`.
 *
 * Escrituras condicionales (todo o nada):
 * - inicio: sesión nueva (`attribute_not_exists`, bloquea ids con tombstone) y,
 *   si queda ACTIVE, ocupación del conector libre o ya de esta sesión;
 * - fin: sesión en la versión leída y liberación del conector solo si lo ocupa esta sesión;
 * - telemetría: sesión en la versión leída y lectura nueva.
 */
export class DynamoDbSessionRepository implements SessionRepository {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly telemetryRetentionDays: number;

  constructor(db: DynamoDBDocumentClient, tableName: string, telemetryRetentionDays = 30) {
    this.db = db;
    this.tableName = tableName;
    this.telemetryRetentionDays = telemetryRetentionDays;
  }

  async findSession(sessionId: SessionId): Promise<StoredSession | undefined> {
    const item = await this.get<SessionItem | SessionTombstoneItem>(keys.session(sessionId));
    if (item === undefined) {
      return undefined;
    }
    if (item.entity === ENTITY.sessionTombstone) {
      return { kind: 'TOMBSTONE', tombstone: fromTombstoneItem(item) };
    }
    return { kind: 'SESSION', session: { value: fromSessionItem(item), version: item.version } };
  }

  async findActiveSessionOnConnector(
    stationId: StationId,
    connectorId: ConnectorId,
  ): Promise<SessionId | undefined> {
    const item = await this.get<{ activeSessionId?: SessionId }>(
      keys.connector(stationId, connectorId),
    );
    return item?.activeSessionId;
  }

  async saveStarted(session: ChargingSession): Promise<void> {
    const items: TransactItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: toSessionItem(session, 1),
          ConditionExpression: NEW_ITEM,
        },
      },
    ];
    if (session.isActive) {
      items.push({
        Update: {
          TableName: this.tableName,
          Key: keys.connector(session.terms.stationId, session.terms.connectorId),
          UpdateExpression:
            'SET entity = :entity, activeSessionId = :session, stationId = :station, connectorId = :connector, since = :since',
          ConditionExpression:
            'attribute_not_exists(activeSessionId) OR activeSessionId = :session',
          ExpressionAttributeValues: {
            ':entity': ENTITY.connector,
            ':session': session.id,
            ':station': session.terms.stationId,
            ':connector': session.terms.connectorId,
            ':since': session.startedAt.toISOString(),
          },
        },
      });
    }
    await this.transact(items);
  }

  async saveEnded(input: { session: ChargingSession; expectedVersion: number }): Promise<void> {
    const { session, expectedVersion } = input;
    await this.transact([
      {
        // Reescritura completa: al no estar ACTIVE, desaparecen los atributos de GSI2.
        Put: {
          TableName: this.tableName,
          Item: toSessionItem(session, expectedVersion + 1),
          ConditionExpression: 'version = :read',
          ExpressionAttributeValues: { ':read': expectedVersion },
        },
      },
      {
        // Libera el conector solo si lo ocupa esta sesión (o ya está libre).
        Delete: {
          TableName: this.tableName,
          Key: keys.connector(session.terms.stationId, session.terms.connectorId),
          ConditionExpression:
            'attribute_not_exists(activeSessionId) OR activeSessionId = :session',
          ExpressionAttributeValues: { ':session': session.id },
        },
      },
    ]);
  }

  async saveTelemetry(input: {
    session: ChargingSession;
    expectedVersion: number;
    record: TelemetryRecord;
  }): Promise<void> {
    await this.transact([
      {
        Put: {
          TableName: this.tableName,
          Item: toSessionItem(input.session, input.expectedVersion + 1),
          ConditionExpression: 'version = :read',
          ExpressionAttributeValues: { ':read': input.expectedVersion },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: toTelemetryItem(input.record, this.telemetryRetentionDays),
          ConditionExpression: NEW_ITEM,
        },
      },
    ]);
  }

  async saveTombstone(tombstone: SessionTombstone): Promise<void> {
    await dynamo(() =>
      this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toTombstoneItem(tombstone),
          ConditionExpression: NEW_ITEM,
        }),
      ),
    );
  }

  async findTelemetry(sessionId: SessionId, timestamp: Date): Promise<TelemetryRecord | undefined> {
    const item = await this.get<TelemetryItem>(keys.telemetry(sessionId, timestamp.toISOString()));
    return item === undefined ? undefined : fromTelemetryItem(item);
  }

  async listTelemetry(sessionId: SessionId, limit: number): Promise<readonly TelemetryRecord[]> {
    const result = await dynamo(() =>
      this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tel)',
          ExpressionAttributeValues: {
            ':pk': keys.sessionPartition(sessionId),
            ':tel': keys.telemetryPrefix,
          },
          ScanIndexForward: false,
          Limit: limit,
        }),
      ),
    );
    return ((result.Items ?? []) as TelemetryItem[]).map(fromTelemetryItem);
  }

  async listStationSessions(
    stationId: StationId,
    page: { active: boolean; limit: number; cursor?: string },
  ): Promise<SessionPage> {
    const index = page.active
      ? { name: GSI2, pk: 'GSI2PK', partition: keys.stationActive(stationId) }
      : { name: GSI1, pk: 'GSI1PK', partition: keys.stationHistory(stationId) };
    const startKey =
      page.cursor === undefined ? undefined : decodeCursor(page.cursor, index.pk, index.partition);
    const result = await dynamo(() =>
      this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: index.name,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': index.pk },
          ExpressionAttributeValues: { ':pk': index.partition },
          ScanIndexForward: page.active,
          Limit: page.limit,
          ExclusiveStartKey: startKey,
        }),
      ),
    );
    const items = ((result.Items ?? []) as SessionItem[]).map(fromSessionItem);
    const last = result.LastEvaluatedKey;
    return last === undefined ? { items } : { items, nextCursor: encodeCursor(last) };
  }

  private async get<T>(key: { PK: string; SK: string }): Promise<T | undefined> {
    const { Item } = await dynamo(() =>
      this.db.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true })),
    );
    return Item as T | undefined;
  }

  private async transact(items: TransactItem[]): Promise<void> {
    await dynamo(() => this.db.send(new TransactWriteCommand({ TransactItems: items })));
  }
}

/** Cursor opaco: clave de la última fila (base64url), validado contra la partición del índice. */
function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(
  cursor: string,
  partitionAttribute: string,
  partition: string,
): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof key === 'object' &&
      key !== null &&
      (key as Record<string, unknown>)[partitionAttribute] === partition &&
      typeof (key as Record<string, unknown>).PK === 'string' &&
      typeof (key as Record<string, unknown>).SK === 'string'
    ) {
      return key as Record<string, unknown>;
    }
  } catch {
    // cursor ilegible
  }
  throw new InvalidCursorError('cursor de paginación inválido');
}
