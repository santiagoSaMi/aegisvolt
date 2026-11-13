import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import {
  ConcurrentModificationError,
  StationAlreadyExistsError,
  type StationEntry,
  type StationRepository,
} from '../../application/index.ts';
import type { City, StationId } from '../../domain/index.ts';
import { dynamo } from './errors.ts';
import {
  fromConnectorItem,
  fromStationItem,
  toConnectorItem,
  toStationItem,
  type ConnectorItem,
  type StationItem,
} from './mappers.ts';
import { ENTITY, GSI1, keys } from './table.ts';

type CatalogItem = StationItem | ConnectorItem;

/** Catálogo de estaciones y conectores en `aegisvolt-reservations-<env>`. */
export class DynamoDbStationRepository implements StationRepository {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(db: DynamoDBDocumentClient, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  /** Lectura fuertemente consistente de la partición de la estación. */
  async findById(stationId: StationId): Promise<StationEntry | undefined> {
    const items = await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.stationPartition(stationId) },
      ConsistentRead: true,
    });
    return groupByStation(items)[0];
  }

  /**
   * Estaciones de una ciudad por el índice GSI1 (sin Scan). Los GSI son de
   * consistencia eventual: el estado de los conectores puede llevar un retraso
   * breve; la reserva en sí siempre se decide con lectura consistente y escritura
   * condicional.
   */
  async listByCity(city: City): Promise<StationEntry[]> {
    const items = await this.queryAll({
      TableName: this.tableName,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :city',
      ExpressionAttributeValues: { ':city': keys.cityPartition(city.value) },
    });
    return groupByStation(items);
  }

  async create(entry: StationEntry): Promise<void> {
    const now = new Date();
    const city = entry.station.city.value;
    const condition = { ConditionExpression: 'attribute_not_exists(PK)' };
    try {
      await dynamo(() =>
        this.db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: toStationItem(entry.station),
                  ...condition,
                },
              },
              ...entry.connectors.map((connector) => ({
                Put: {
                  TableName: this.tableName,
                  Item: toConnectorItem(connector, city, 1, now),
                  ...condition,
                },
              })),
            ],
          }),
        ),
      );
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        throw new StationAlreadyExistsError(`La estación ${entry.station.id} ya existe`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async queryAll(
    input: ConstructorParameters<typeof QueryCommand>[0],
  ): Promise<CatalogItem[]> {
    const items: CatalogItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await dynamo(() =>
        this.db.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })),
      );
      items.push(...((page.Items ?? []) as CatalogItem[]));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }
}

/** Agrupa ítems ordenados (estación seguida de sus conectores) por estación. */
function groupByStation(items: readonly CatalogItem[]): StationEntry[] {
  const stations = new Map<string, StationItem>();
  const connectors = new Map<string, ConnectorItem[]>();
  for (const item of items) {
    if (item.entity === ENTITY.station) {
      stations.set(item.stationId, item);
    } else {
      const list = connectors.get(item.stationId) ?? [];
      list.push(item);
      connectors.set(item.stationId, list);
    }
  }
  return [...stations.values()]
    .sort((a, b) => a.stationId.localeCompare(b.stationId))
    .map((stationItem) => ({
      station: fromStationItem(stationItem),
      connectors: (connectors.get(stationItem.stationId) ?? [])
        .sort((a, b) => a.connectorId.localeCompare(b.connectorId))
        .map(fromConnectorItem),
    }));
}
