import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/**
 * Tabla `aegisvolt-sagas-<env>` (single-table, ADR-0006). Único escritor: el orquestador.
 *
 * | Entidad   | PK            | SK             | GSI1PK (por flota) | GSI1SK             | GSI2PK (por estado) | GSI2SK             |
 * | --------- | ------------- | -------------- | ------------------ | ------------------ | ------------------- | ------------------ |
 * | Saga      | SAGA#<id>     | META           | FLEET#<fleet>      | <createdAt>#<id>   | STATUS#<status>     | <updatedAt>#<id>   |
 * | SagaEvent | SAGA#<id>     | EVT#<seq 6>    | —                  | —                  | —                   | —                  |
 *
 * - Estado y eventos nuevos se escriben en UN `TransactWriteItems` condicionado a
 *   `version` y al *lease* (`leaseOwner`): el historial nunca diverge del estado y
 *   dos réplicas no pueden avanzar la misma SAGA.
 * - GSI2 permite a la recuperación (y a Prefect) consultar por estado sin Scan.
 * - Sin TTL: las SAGAs son el registro de auditoría de §2.5.
 */
export const GSI1 = 'GSI1';
export const GSI2 = 'GSI2';

export const keys = {
  saga: (sagaId: string) => ({ PK: `SAGA#${sagaId}`, SK: 'META' }),
  event: (sagaId: string, sequence: number) => ({
    PK: `SAGA#${sagaId}`,
    SK: `EVT#${String(sequence).padStart(6, '0')}`,
  }),
  sagaPartition: (sagaId: string) => `SAGA#${sagaId}`,
  fleet: (fleetId: string) => `FLEET#${fleetId}`,
  status: (status: string) => `STATUS#${status}`,
  eventPrefix: 'EVT#',
} as const;

export const ENTITY = { saga: 'SAGA', event: 'SAGA_EVENT' } as const;

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
