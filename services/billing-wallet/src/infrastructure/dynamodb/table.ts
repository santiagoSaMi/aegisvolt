import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/**
 * Tabla `aegisvolt-billing-<env>` (single-table, ADR-0006). Único escritor: este
 * servicio. Los registros financieros no tienen TTL: se conservan para auditoría.
 *
 * | Entidad            | PK               | SK                        | GSI1PK        | GSI1SK         |
 * | ------------------ | ---------------- | ------------------------- | ------------- | -------------- |
 * | Wallet             | WALLET#<fleet>   | META                      | —             | —              |
 * | Movimiento (ledger)| WALLET#<fleet>   | TX#<occurredAt>#<txId>    | SAGA#<saga>   | TX#<occurredAt>|
 * | Debit / tombstone  | DEBIT#<id>       | META                      | SAGA#<saga>   | DEBIT#<id>     |
 * | Refund             | REFUND#<id>      | META                      | SAGA#<saga>   | REFUND#<id>    |
 * | TopUp              | TOPUP#<id>       | META                      | —             | —              |
 *
 * - El saldo y su libro mayor comparten partición: el historial es una Query.
 * - GSI1 agrupa por SAGA todo lo financiero (auditoría de Prefect).
 * - Débito y tombstone comparten clave: `attribute_not_exists(PK)` impide cobrar
 *   un id ya compensado.
 */
export const GSI1 = 'GSI1';

export const keys = {
  wallet: (fleetId: string) => ({ PK: `WALLET#${fleetId}`, SK: 'META' }),
  ledgerEntry: (fleetId: string, occurredAt: string, transactionId: string) => ({
    PK: `WALLET#${fleetId}`,
    SK: `TX#${occurredAt}#${transactionId}`,
  }),
  debit: (debitId: string) => ({ PK: `DEBIT#${debitId}`, SK: 'META' }),
  refund: (refundId: string) => ({ PK: `REFUND#${refundId}`, SK: 'META' }),
  topUp: (topUpId: string) => ({ PK: `TOPUP#${topUpId}`, SK: 'META' }),
  walletPartition: (fleetId: string) => `WALLET#${fleetId}`,
  sagaPartition: (sagaId: string) => `SAGA#${sagaId}`,
  ledgerPrefix: 'TX#',
} as const;

export const ENTITY = {
  wallet: 'WALLET',
  ledgerEntry: 'LEDGER_ENTRY',
  debit: 'DEBIT',
  debitTombstone: 'DEBIT_TOMBSTONE',
  refund: 'REFUND',
  topUp: 'TOP_UP',
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
    ],
  };
}
