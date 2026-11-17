import { randomUUID } from 'node:crypto';

import {
  CachedFeatureFlagReader,
  DynamoDbFeatureFlagSource,
  type FeatureFlagKey,
} from '@aegisvolt/feature-flags';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN_GROUP,
  FeatureFlagVersionConflictError,
  ForbiddenError,
  OPERATOR_GROUP,
  type Principal,
} from '../../src/application/index.ts';
import { createFlagUseCases } from '../../src/composition.ts';
import { loadFlagsConfig } from '../../src/config.ts';
import { FixedClock } from '../support/in-memory-feature-flag-repository.ts';
import {
  FLOCI_ENDPOINT,
  createClients,
  createSeededFlagsTable,
  deleteTable,
  flociAvailable,
} from './floci.ts';

const ADMIN: Principal = { subject: 'admin-sub-dev', groups: [ADMIN_GROUP] };
const OPERATOR: Principal = { subject: 'operator-sub', groups: [OPERATOR_GROUP] };
const ENVIRONMENTS = ['dev', 'test', 'prod'] as const;
type Env = (typeof ENVIRONMENTS)[number];

describe.skipIf(!flociAvailable)(
  `Feature flags aisladas por ambiente en DynamoDB de Floci (${FLOCI_ENDPOINT})`,
  () => {
    const clients = createClients();
    const suffix = randomUUID().slice(0, 8);
    /** Una tabla por ambiente, como en los despliegues (`aegisvolt-feature-flags-<env>`). */
    const tables: Record<Env, string> = {
      dev: `aegisvolt-feature-flags-it-${suffix}-dev`,
      test: `aegisvolt-feature-flags-it-${suffix}-test`,
      prod: `aegisvolt-feature-flags-it-${suffix}-prod`,
    };
    const clock = new FixedClock(new Date('2026-11-13T15:00:00.000Z'));
    /** Un "despliegue" del graphql-api por ambiente: cada uno solo conoce su tabla. */
    const deployment = (environment: Env) =>
      createFlagUseCases({
        documentClient: clients.documentClient,
        tableName: tables[environment],
        environment,
        cacheTtlMs: 0,
        clock,
      });
    /** Lector que usan los SERVICIOS (station, billing, dispatch) en cada ambiente. */
    const serviceReader = (environment: Env) =>
      new CachedFeatureFlagReader(
        new DynamoDbFeatureFlagSource(clients.documentClient, tables[environment]),
        { ttlMs: 60_000 },
      );
    const item = async (environment: Env, key: string) =>
      (
        await clients.documentClient.send(
          new GetCommand({
            TableName: tables[environment],
            Key: { PK: `FLAG#${key}`, SK: 'META' },
            ConsistentRead: true,
          }),
        )
      ).Item;
    const auditItems = async (environment: Env, key: string) =>
      (
        await clients.documentClient.send(
          new QueryCommand({
            TableName: tables[environment],
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :a)',
            ExpressionAttributeValues: { ':pk': `FLAG#${key}`, ':a': 'AUDIT#' },
            ConsistentRead: true,
          }),
        )
      ).Items ?? [];
    const values = async (environment: Env) =>
      Object.fromEntries(
        (await deployment(environment).getFeatureFlags.execute(OPERATOR)).flags.map((f) => [
          f.key,
          f.enabled,
        ]),
      );

    beforeAll(async () => {
      await Promise.all(
        ENVIRONMENTS.map((environment) =>
          createSeededFlagsTable(clients, tables[environment], environment),
        ),
      );
    });

    afterAll(async () => {
      await Promise.allSettled(ENVIRONMENTS.map((env) => deleteTable(clients, tables[env])));
      clients.client.destroy();
    });

    it('cada ambiente arranca con sus valores iniciales', async () => {
      expect(await values('dev')).toEqual({
        ENABLE_DYNAMIC_SURGE_PRICING: true,
        ENABLE_FAST_CHARGE_BOOST: true,
        SIMULATE_CHARGER_HARDWARE_FAULT: false,
      });
      expect(await values('test')).toEqual({
        ENABLE_DYNAMIC_SURGE_PRICING: true,
        ENABLE_FAST_CHARGE_BOOST: false,
        SIMULATE_CHARGER_HARDWARE_FAULT: true,
      });
      expect(await values('prod')).toEqual({
        ENABLE_DYNAMIC_SURGE_PRICING: false,
        ENABLE_FAST_CHARGE_BOOST: false,
        SIMULATE_CHARGER_HARDWARE_FAULT: false,
      });
    });

    it('modificar dev no afecta test ni prod; los servicios de dev lo ven sin redesplegar', async () => {
      const readers = {
        dev: serviceReader('dev'),
        test: serviceReader('test'),
        prod: serviceReader('prod'),
      };
      const fault: FeatureFlagKey = 'SIMULATE_CHARGER_HARDWARE_FAULT';
      // Los servicios ya leyeron (y cachearon) el valor anterior.
      expect(await readers.dev.isEnabled(fault)).toBe(false);
      expect(await readers.test.isEnabled(fault)).toBe(true);
      expect(await readers.prod.isEnabled(fault)).toBe(false);
      const testBefore = await item('test', fault);
      const prodBefore = await item('prod', fault);

      const correlationId = randomUUID();
      const result = await deployment('dev').updateFeatureFlag.execute(ADMIN, {
        key: fault,
        enabled: true,
        correlationId,
      });
      await deployment('dev').updateFeatureFlag.execute(ADMIN, {
        key: 'ENABLE_DYNAMIC_SURGE_PRICING',
        enabled: false,
        correlationId,
      });

      // dev: cambiado, versión 2, con auditoría completa.
      expect(result.changed).toBe(true);
      expect(await item('dev', fault)).toMatchObject({
        enabled: true,
        version: 2,
        updatedBy: 'admin-sub-dev',
      });
      expect(await auditItems('dev', fault)).toEqual([
        expect.objectContaining({
          key: fault,
          from: false,
          to: true,
          version: 2,
          changedBy: 'admin-sub-dev',
          correlationId,
          environment: 'dev',
        }),
      ]);

      // test y prod: ítems idénticos (misma versión) y sin auditoría.
      expect(await item('test', fault)).toEqual(testBefore);
      expect(await item('prod', fault)).toEqual(prodBefore);
      expect(await auditItems('test', fault)).toHaveLength(0);
      expect(await auditItems('prod', fault)).toHaveLength(0);
      expect(await values('test')).toMatchObject({
        ENABLE_DYNAMIC_SURGE_PRICING: true,
        SIMULATE_CHARGER_HARDWARE_FAULT: true,
      });
      expect(await values('prod')).toMatchObject({
        ENABLE_DYNAMIC_SURGE_PRICING: false,
        SIMULATE_CHARGER_HARDWARE_FAULT: false,
      });

      // Los servicios de dev lo ven al actualizar su caché (TTL o invalidación),
      // sin reiniciar ni redesplegar; los de test y prod siguen igual.
      readers.dev.invalidate();
      readers.test.invalidate();
      readers.prod.invalidate();
      expect(await readers.dev.isEnabled(fault)).toBe(true);
      expect(await readers.dev.isEnabled('ENABLE_DYNAMIC_SURGE_PRICING')).toBe(false);
      expect(await readers.test.isEnabled(fault)).toBe(true);
      expect(await readers.prod.isEnabled(fault)).toBe(false);
      expect(await readers.prod.isEnabled('ENABLE_DYNAMIC_SURGE_PRICING')).toBe(false);
    });

    it('un operador no puede escribir: nada cambia y no hay auditoría', async () => {
      const before = await item('prod', 'ENABLE_FAST_CHARGE_BOOST');

      await expect(
        deployment('prod').updateFeatureFlag.execute(OPERATOR, {
          key: 'ENABLE_FAST_CHARGE_BOOST',
          enabled: true,
          correlationId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(await item('prod', 'ENABLE_FAST_CHARGE_BOOST')).toEqual(before);
      expect(await auditItems('prod', 'ENABLE_FAST_CHARGE_BOOST')).toHaveLength(0);
    });

    it('dos administradores con la misma versión esperada: uno gana, el otro recibe conflicto', async () => {
      const key = 'ENABLE_FAST_CHARGE_BOOST';
      const outcomes = await Promise.allSettled(
        [false, false].map(() =>
          deployment('test').updateFeatureFlag.execute(ADMIN, {
            key,
            enabled: true,
            expectedVersion: 1,
            correlationId: randomUUID(),
          }),
        ),
      );

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
        FeatureFlagVersionConflictError,
      );
      expect(await item('test', key)).toMatchObject({ enabled: true, version: 2 });
      expect(await auditItems('test', key)).toHaveLength(1);
      // Y dev/prod siguen sin cambios en esa flag.
      expect(await item('prod', key)).toMatchObject({ enabled: false, version: 1 });
    });

    it('un despliegue de dev no puede configurarse contra la tabla de prod', () => {
      expect(() =>
        loadFlagsConfig({
          APP_ENV: 'dev',
          FEATURE_FLAGS_TABLE_NAME: 'aegisvolt-feature-flags-prod',
        }),
      ).toThrow(/FEATURE_FLAGS_TABLE_NAME/);
    });
  },
);
