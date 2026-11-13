import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import {
  DynamoDbFeatureFlagSource,
  InvalidFeatureFlagError,
  featureFlagKeys,
  featureFlagsTableName,
} from '../src/index.ts';

/** Cliente falso: registra la última petición y devuelve el ítem indicado. */
function fakeClient(item: Record<string, unknown> | undefined) {
  const sent: { input: Record<string, unknown> }[] = [];
  const client = {
    send: (command: { input: Record<string, unknown> }) => {
      sent.push(command);
      return Promise.resolve({ Item: item });
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

const VALID = {
  key: 'SIMULATE_CHARGER_HARDWARE_FAULT',
  enabled: true,
  version: 3,
  updatedAt: '2026-11-13T12:00:00.000Z',
  updatedBy: 'admin',
};

describe('DynamoDbFeatureFlagSource', () => {
  it('lee FLAG#<key>/META de la tabla del ambiente con lectura consistente', async () => {
    const { client, sent } = fakeClient(VALID);
    const source = new DynamoDbFeatureFlagSource(client, featureFlagsTableName('dev'));

    expect(await source.fetch('SIMULATE_CHARGER_HARDWARE_FAULT')).toEqual(VALID);
    expect(sent[0]?.input).toMatchObject({
      TableName: 'aegisvolt-feature-flags-dev',
      Key: featureFlagKeys.flag('SIMULATE_CHARGER_HARDWARE_FAULT'),
      ConsistentRead: true,
    });
  });

  it('devuelve undefined si la flag no existe', async () => {
    const source = new DynamoDbFeatureFlagSource(fakeClient(undefined).client, 't');

    expect(await source.fetch('ENABLE_FAST_CHARGE_BOOST')).toBeUndefined();
  });

  it('rechaza un ítem que no cumple el contrato o es de otra flag', async () => {
    const invalid = new DynamoDbFeatureFlagSource(
      fakeClient({ ...VALID, enabled: 'yes' }).client,
      't',
    );
    await expect(invalid.fetch('SIMULATE_CHARGER_HARDWARE_FAULT')).rejects.toBeInstanceOf(
      InvalidFeatureFlagError,
    );

    const other = new DynamoDbFeatureFlagSource(fakeClient(VALID).client, 't');
    await expect(other.fetch('ENABLE_FAST_CHARGE_BOOST')).rejects.toBeInstanceOf(
      InvalidFeatureFlagError,
    );
  });
});
