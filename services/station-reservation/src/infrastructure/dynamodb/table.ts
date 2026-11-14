import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/**
 * Tabla `aegisvolt-reservations-<env>` (single-table, ADR-0006). Único escritor:
 * este servicio.
 *
 * | Entidad     | PK               | SK          | GSI1PK        | GSI1SK                      |
 * | ----------- | ---------------- | ----------- | ------------- | --------------------------- |
 * | Station     | STATION#<id>     | META        | CITY#<city>   | STATION#<id>                |
 * | Connector   | STATION#<id>     | CONN#<cid>  | CITY#<city>   | STATION#<id>#CONN#<cid>     |
 * | Reservation | RES#<id>         | META        | —             | —                           |
 *
 * GSI2 (desde la fase GraphQL): reservas por flota, `FLEET#<fleetId>` /
 * `<createdAt>#<reservationId>` (solo ítems Reservation; los tombstones no).
 * | Tombstone   | RES#<id>         | META        | —             | —                           |
 *
 * Reserva y tombstone comparten clave: `attribute_not_exists(PK)` impide crear
 * una reserva con un id ya compensado y viceversa.
 */
export const GSI1 = 'GSI1';
export const GSI2 = 'GSI2';

/** Atributo TTL: solo en registros terminales, para limpieza diferida (retención). */
export const TTL_ATTRIBUTE = 'expiresAtEpoch';
export const TERMINAL_RECORD_RETENTION_DAYS = 30;

export const keys = {
  station: (stationId: string) => ({ PK: `STATION#${stationId}`, SK: 'META' }),
  connector: (stationId: string, connectorId: string) => ({
    PK: `STATION#${stationId}`,
    SK: `CONN#${connectorId}`,
  }),
  reservation: (reservationId: string) => ({ PK: `RES#${reservationId}`, SK: 'META' }),
  fleetPartition: (fleetId: string) => `FLEET#${fleetId}`,
  stationPartition: (stationId: string) => `STATION#${stationId}`,
  cityPartition: (city: string) => `CITY#${city}`,
} as const;

export const ENTITY = {
  station: 'STATION',
  connector: 'CONNECTOR',
  reservation: 'RESERVATION',
  tombstone: 'RESERVATION_TOMBSTONE',
} as const;

/**
 * Definición de la tabla. En los ambientes la crea Terraform (fase de IaC);
 * aquí se usa para la tabla local de desarrollo y las pruebas de integración.
 */
export function tableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
      { AttributeName: 'GSI1PK', AttributeType: 'S' },
      { AttributeName: 'GSI1SK', AttributeType: 'S' },
      { AttributeName: 'GSI2PK', AttributeType: 'S' },
      { AttributeName: 'GSI2SK', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: GSI1,
        KeySchema: [
          { AttributeName: 'GSI1PK', KeyType: 'HASH' },
          { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: GSI2,
        KeySchema: [
          { AttributeName: 'GSI2PK', KeyType: 'HASH' },
          { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  };
}
