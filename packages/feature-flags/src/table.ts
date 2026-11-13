import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

import type { FeatureFlagKey } from './reader.ts';

/**
 * Tabla `aegisvolt-feature-flags-<env>` (ADR-0007). El ambiente lo determina el
 * nombre de la tabla: `dev`, `test` y `prod` no comparten almacén.
 *
 * | Entidad  | PK            | SK              | Atributos                                         |
 * | -------- | ------------- | --------------- | ------------------------------------------------- |
 * | Flag     | FLAG#<key>    | META            | key, enabled, version, updatedAt, updatedBy       |
 * | FlagAudit| FLAG#<key>    | AUDIT#<ts>#<v>  | from, to, version, updatedBy, updatedAt           |
 *
 * Único escritor: graphql-api (`setFeatureFlag`); en local, `scripts/set-flag.ts`.
 * Los servicios solo leen.
 */
export const featureFlagKeys = {
  flag: (key: FeatureFlagKey) => ({ PK: `FLAG#${key}`, SK: 'META' }),
  audit: (key: FeatureFlagKey, at: string, version: number) => ({
    PK: `FLAG#${key}`,
    SK: `AUDIT#${at}#${String(version).padStart(8, '0')}`,
  }),
} as const;

/** Nombre de la tabla de un ambiente. */
export const featureFlagsTableName = (environment: string): string =>
  `aegisvolt-feature-flags-${environment}`;

/** Definición de la tabla (en los ambientes la crea Terraform; aquí, local y pruebas). */
export function featureFlagsTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
  };
}
