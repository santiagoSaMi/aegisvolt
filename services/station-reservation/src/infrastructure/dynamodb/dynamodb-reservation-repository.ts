import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type {
  ReservationRepository,
  StoredReservation,
  Versioned,
  VersionedUpdate,
} from '../../application/index.ts';
import type {
  ChargingConnector,
  ConnectorId,
  Reservation,
  ReservationId,
  ReservationTombstone,
  StationId,
} from '../../domain/index.ts';
import { dynamo } from './errors.ts';
import {
  fromConnectorItem,
  fromReservationItem,
  fromTombstoneItem,
  retentionEpoch,
  toReservationItem,
  toTombstoneItem,
  type ConnectorItem,
  type ReservationItem,
  type TombstoneItem,
} from './mappers.ts';
import { ENTITY, keys } from './table.ts';

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * Reservas y estado de conectores. Toda escritura es condicional:
 * - versión del ítem (concurrencia optimista);
 * - `attribute_not_exists(PK)` para ids nuevos (reservas y tombstones);
 * - para bloquear un conector, además, que esté disponible en `now`
 *   (AVAILABLE o RESERVED vencido): la condición de DynamoDB repite la regla del
 *   dominio, de modo que la atomicidad no depende solo de la lectura previa.
 */
export class DynamoDbReservationRepository implements ReservationRepository {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(db: DynamoDBDocumentClient, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  async findConnector(
    stationId: StationId,
    connectorId: ConnectorId,
  ): Promise<Versioned<ChargingConnector> | undefined> {
    const { Item } = await dynamo(() =>
      this.db.send(
        new GetCommand({
          TableName: this.tableName,
          Key: keys.connector(stationId, connectorId),
          ConsistentRead: true,
        }),
      ),
    );
    if (Item === undefined) {
      return undefined;
    }
    const item = Item as ConnectorItem;
    return { value: fromConnectorItem(item), version: item.version };
  }

  async findReservation(reservationId: ReservationId): Promise<StoredReservation | undefined> {
    const { Item } = await dynamo(() =>
      this.db.send(
        new GetCommand({
          TableName: this.tableName,
          Key: keys.reservation(reservationId),
          ConsistentRead: true,
        }),
      ),
    );
    if (Item === undefined) {
      return undefined;
    }
    const item = Item as ReservationItem | TombstoneItem;
    if (item.entity === ENTITY.tombstone) {
      return { kind: 'TOMBSTONE', tombstone: fromTombstoneItem(item) };
    }
    return {
      kind: 'RESERVATION',
      reservation: { value: fromReservationItem(item), version: item.version },
    };
  }

  async saveHold(input: {
    connector: VersionedUpdate<ChargingConnector>;
    reservation: Reservation;
    displaced: VersionedUpdate<Reservation> | undefined;
    now: Date;
  }): Promise<void> {
    const transactItems: TransactItem[] = [
      this.connectorUpdate(input.connector, input.now, {
        expression: '(#status = :available OR (#status = :reserved AND holdExpiresAt <= :now))',
        values: {
          ':available': 'AVAILABLE',
          ':reserved': 'RESERVED',
          ':now': input.now.toISOString(),
        },
      }),
      {
        Put: {
          TableName: this.tableName,
          Item: toReservationItem(input.reservation, 1),
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];
    if (input.displaced !== undefined) {
      transactItems.push(this.reservationUpdate(input.displaced));
    }
    await this.transact(transactItems);
  }

  async saveTransition(input: {
    reservation: VersionedUpdate<Reservation>;
    connector: VersionedUpdate<ChargingConnector> | undefined;
    now: Date;
  }): Promise<void> {
    const transactItems: TransactItem[] = [this.reservationUpdate(input.reservation)];
    if (input.connector !== undefined) {
      // El conector solo cambia si lo bloquea u ocupa ESTA reserva.
      transactItems.push(
        this.connectorUpdate(input.connector, input.now, {
          expression: 'holdReservationId = :reservationId',
          values: { ':reservationId': input.reservation.value.id },
        }),
      );
    }
    await this.transact(transactItems);
  }

  async saveTombstone(tombstone: ReservationTombstone): Promise<void> {
    await dynamo(() =>
      this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toTombstoneItem(tombstone),
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      ),
    );
  }

  private connectorUpdate(
    update: VersionedUpdate<ChargingConnector>,
    now: Date,
    extraCondition: { expression: string; values: Record<string, string> },
  ): TransactItem {
    const connector = update.value;
    const hold = connector.hold;
    const set = ['#status = :status', '#version = :nextVersion', 'updatedAt = :updatedAt'];
    const values: Record<string, unknown> = {
      ':status': connector.status,
      ':nextVersion': update.expectedVersion + 1,
      ':expectedVersion': update.expectedVersion,
      ':updatedAt': now.toISOString(),
      ...extraCondition.values,
    };
    let remove = '';
    if (hold === undefined) {
      remove = ' REMOVE holdReservationId, holdExpiresAt';
    } else {
      set.push('holdReservationId = :holdReservationId', 'holdExpiresAt = :holdExpiresAt');
      values[':holdReservationId'] = hold.reservationId;
      values[':holdExpiresAt'] = hold.expiresAt.toISOString();
    }
    return {
      Update: {
        TableName: this.tableName,
        Key: keys.connector(connector.stationId, connector.id),
        UpdateExpression: `SET ${set.join(', ')}${remove}`,
        ConditionExpression: `attribute_exists(PK) AND #version = :expectedVersion AND ${extraCondition.expression}`,
        ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
        ExpressionAttributeValues: values,
      },
    };
  }

  private reservationUpdate(update: VersionedUpdate<Reservation>): TransactItem {
    const reservation = update.value;
    const terminal = reservation.status === 'RELEASED' || reservation.status === 'EXPIRED';
    const set = ['#status = :status', '#version = :nextVersion', 'updatedAt = :updatedAt'];
    const values: Record<string, unknown> = {
      ':status': reservation.status,
      ':nextVersion': update.expectedVersion + 1,
      ':expectedVersion': update.expectedVersion,
      ':updatedAt': reservation.updatedAt.toISOString(),
    };
    if (reservation.releaseReason !== undefined) {
      set.push('releaseReason = :releaseReason');
      values[':releaseReason'] = reservation.releaseReason;
    }
    if (terminal) {
      set.push('expiresAtEpoch = :expiresAtEpoch');
      values[':expiresAtEpoch'] = retentionEpoch(reservation.updatedAt);
    }
    return {
      Update: {
        TableName: this.tableName,
        Key: keys.reservation(reservation.id),
        UpdateExpression: `SET ${set.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
        ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
        ExpressionAttributeValues: values,
      },
    };
  }

  private async transact(transactItems: TransactItem[]): Promise<void> {
    await dynamo(() => this.db.send(new TransactWriteCommand({ TransactItems: transactItems })));
  }
}
