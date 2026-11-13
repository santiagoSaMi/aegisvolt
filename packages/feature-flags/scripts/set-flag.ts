// Cambia una flag en la tabla de un ambiente LOCAL (Floci), con versión
// condicional y un registro de auditoría en la misma transacción (ADR-0007).
// En los ambientes desplegados el único escritor es la mutación setFeatureFlag.
// Uso: pnpm --filter @aegisvolt/feature-flags flags:set <env> <KEY> <true|false> [usuario]
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { featureFlagsV1 } from '@aegisvolt/contracts';

import { featureFlagKeys } from '../src/table.ts';
import { localClients, tableNameFor } from './local-client.ts';

const [environment, rawKey, rawValue, updatedBy = 'local-script'] = process.argv.slice(2);
const key = featureFlagsV1.featureFlagKeySchema.safeParse(rawKey);
if (environment === undefined || !key.success || (rawValue !== 'true' && rawValue !== 'false')) {
  process.stderr.write(
    `Uso: set-flag.ts <env> <${featureFlagsV1.FEATURE_FLAG_KEYS.join('|')}> <true|false> [usuario]\n`,
  );
  process.exit(2);
}

const enabled = rawValue === 'true';
const tableName = tableNameFor(environment);
const { client, documentClient } = localClients();

try {
  const { Item } = await documentClient.send(
    new GetCommand({
      TableName: tableName,
      Key: featureFlagKeys.flag(key.data),
      ConsistentRead: true,
    }),
  );
  const current = Item as { enabled?: boolean; version?: number } | undefined;
  const version = (current?.version ?? 0) + 1;
  const updatedAt = new Date().toISOString();

  await documentClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              ...featureFlagKeys.flag(key.data),
              key: key.data,
              enabled,
              version,
              updatedAt,
              updatedBy,
            },
            // Nadie más cambió la flag desde la lectura (concurrencia optimista).
            ConditionExpression:
              current === undefined ? 'attribute_not_exists(PK)' : 'version = :read',
            ...(current === undefined
              ? {}
              : { ExpressionAttributeValues: { ':read': current.version } }),
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              ...featureFlagKeys.audit(key.data, updatedAt, version),
              key: key.data,
              from: current?.enabled ?? null,
              to: enabled,
              version,
              updatedBy,
              updatedAt,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }),
  );
  process.stdout.write(
    `${tableName}: ${key.data} ${String(current?.enabled ?? 'ausente')} → ${String(enabled)} (v${version})\n`,
  );
} finally {
  client.destroy();
}
