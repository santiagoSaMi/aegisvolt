import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/**
 * Tabla `aegisvolt-dispatch-<env>` (single-table, ADR-0006). Único escritor: este servicio.
 *
 * | Entidad              | PK                     | SK          | GSI1PK (histórico)  | GSI1SK              | GSI2PK (activas)  | GSI2SK                 |
 * | -------------------- | ---------------------- | ----------- | ------------------- | ------------------- | ----------------- | ---------------------- |
 * | Session / tombstone  | SESSION#<id>           | META        | STATION#<st>        | <startedAt>#<id>    | ACTIVE#<st> (*)   | <connectorId>#<id> (*) |
 * | Telemetría           | SESSION#<id>           | TEL#<ts>    | —                   | —                   | —                 | —                      |
 * | Ocupación conector   | CONN#<st>#<cn>         | META        | —                   | —                   | —                 | —                      |
 *
 * (*) GSI2 es *sparse*: solo las sesiones ACTIVE tienen esos atributos; al terminar
 *     la sesión se reescribe sin ellos y sale del índice.
 * - La sesión y su telemetría comparten partición: la telemetría es una Query.
 * - La ocupación del conector es el candado que impide dos sesiones ACTIVE en el
 *   mismo conector (`attribute_not_exists(activeSessionId)`).
 * - Sesión y tombstone comparten clave: `attribute_not_exists(PK)` impide activar
 *   un id ya abortado.
 * - La telemetría lleva `ttl` (epoch s) para que DynamoDB la expire; el TTL de la
 *   tabla se habilita en Terraform (fase de IaC).
 */
export const GSI1 = 'GSI1';
export const GSI2 = 'GSI2';

export const keys = {
  session: (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: 'META' }),
  telemetry: (sessionId: string, timestamp: string) => ({
    PK: `SESSION#${sessionId}`,
    SK: `TEL#${timestamp}`,
  }),
  connector: (stationId: string, connectorId: string) => ({
    PK: `CONN#${stationId}#${connectorId}`,
    SK: 'META',
  }),
  sessionPartition: (sessionId: string) => `SESSION#${sessionId}`,
  stationHistory: (stationId: string) => `STATION#${stationId}`,
  stationActive: (stationId: string) => `ACTIVE#${stationId}`,
  telemetryPrefix: 'TEL#',
} as const;

export const ENTITY = {
  session: 'SESSION',
  sessionTombstone: 'SESSION_TOMBSTONE',
  telemetry: 'TELEMETRY',
  connector: 'CONNECTOR_OCCUPANCY',
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
