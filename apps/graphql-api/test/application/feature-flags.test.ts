import { describe, expect, it } from 'vitest';

import {
  ADMIN_GROUP,
  FeatureFlagNotFoundError,
  FeatureFlagVersionConflictError,
  FlagSnapshotCache,
  ForbiddenError,
  GetFeatureFlags,
  ListFeatureFlagChanges,
  OPERATOR_GROUP,
  UnauthorizedError,
  UpdateFeatureFlag,
  type DeploymentEnvironment,
  type Principal,
} from '../../src/application/index.ts';
import { ActorId, FeatureFlag, FeatureFlagKey, InvalidValueError } from '../../src/domain/index.ts';
import {
  FixedClock,
  InMemoryFeatureFlagRepository,
} from '../support/in-memory-feature-flag-repository.ts';

const START = new Date('2026-11-13T15:00:00.000Z');
const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const ADMIN: Principal = { subject: 'admin-sub-1', groups: [ADMIN_GROUP] };
const OPERATOR: Principal = { subject: 'operator-sub-1', groups: [OPERATOR_GROUP] };

function context(environment: DeploymentEnvironment = 'dev', ttlMs = 5_000) {
  const clock = new FixedClock(START);
  const flags = InMemoryFeatureFlagRepository.seeded(
    environment === 'local' ? 'local' : environment,
    START,
  );
  const cache = new FlagSnapshotCache({ ttlMs, clock });
  const deps = { flags, cache, clock, environment };
  return {
    clock,
    flags,
    get: new GetFeatureFlags(deps),
    update: new UpdateFeatureFlag(deps),
    changes: new ListFeatureFlagChanges({ flags }),
  };
}

const valueOf = (snapshot: Awaited<ReturnType<GetFeatureFlags['execute']>>, key: string) =>
  snapshot.flags.find((f) => f.key === key);

describe('GetFeatureFlags', () => {
  it('devuelve las tres flags del ambiente del despliegue con sus valores iniciales', async () => {
    const ctx = context('test');

    const snapshot = await ctx.get.execute(OPERATOR);

    expect(snapshot.environment).toBe('test');
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.flags.map((f) => [f.key, f.enabled, f.source])).toEqual([
      ['ENABLE_DYNAMIC_SURGE_PRICING', true, 'STORE'],
      ['ENABLE_FAST_CHARGE_BOOST', false, 'STORE'],
      ['SIMULATE_CHARGER_HARDWARE_FAULT', true, 'STORE'],
    ]);
  });

  it('exige una identidad verificada de la plataforma', async () => {
    const ctx = context();
    await expect(ctx.get.execute(undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(ctx.get.execute({ subject: 'x', groups: ['otro'] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('cachea con TTL corto: no relee la tabla dentro del TTL y sí al vencer', async () => {
    const ctx = context('dev', 5_000);
    await ctx.get.execute(OPERATOR);
    await ctx.get.execute(OPERATOR);
    expect(ctx.flags.reads).toBe(1);

    ctx.clock.advance(5_000);
    await ctx.get.execute(OPERATOR);
    expect(ctx.flags.reads).toBe(2);
  });

  it('fuente no disponible: último valor conocido, marcado como degradado', async () => {
    const ctx = context('test', 1_000);
    await ctx.get.execute(OPERATOR);
    ctx.flags.unavailable = true;
    ctx.clock.advance(1_000);

    const snapshot = await ctx.get.execute(OPERATOR);

    expect(snapshot.degraded).toBe(true);
    expect(valueOf(snapshot, 'SIMULATE_CHARGER_HARDWARE_FAULT')).toMatchObject({
      enabled: true,
      source: 'LAST_KNOWN',
    });
  });

  it('fuente no disponible y sin valor conocido: valores SEGUROS (todo false)', async () => {
    const ctx = context('test');
    ctx.flags.unavailable = true;

    const snapshot = await ctx.get.execute(OPERATOR);

    expect(snapshot.degraded).toBe(true);
    expect(snapshot.flags.every((f) => !f.enabled && f.source === 'DEFAULT')).toBe(true);
  });

  it('una flag no sembrada en la tabla se muestra con su valor seguro', async () => {
    const ctx = context('dev');
    ctx.flags.flags.delete('ENABLE_DYNAMIC_SURGE_PRICING');

    const snapshot = await ctx.get.execute(OPERATOR);

    expect(valueOf(snapshot, 'ENABLE_DYNAMIC_SURGE_PRICING')).toMatchObject({
      enabled: false,
      source: 'DEFAULT',
    });
    expect(snapshot.degraded).toBe(true);
  });
});

describe('UpdateFeatureFlag', () => {
  const command = (overrides: Record<string, unknown> = {}) => ({
    key: 'ENABLE_DYNAMIC_SURGE_PRICING',
    enabled: false,
    correlationId: CORRELATION_ID,
    ...overrides,
  });

  it('un administrador cambia la flag: versión +1 y auditoría (quién, cuándo, qué, ambiente)', async () => {
    const ctx = context('dev');
    ctx.clock.advance(60_000);

    const result = await ctx.update.execute(ADMIN, command());

    expect(result.changed).toBe(true);
    expect(result.flag).toMatchObject({ enabled: false, version: 2, updatedBy: 'admin-sub-1' });
    expect(ctx.flags.audit).toEqual([
      {
        key: 'ENABLE_DYNAMIC_SURGE_PRICING',
        from: true,
        to: false,
        version: 2,
        changedBy: 'admin-sub-1',
        changedAt: new Date(START.getTime() + 60_000),
        correlationId: CORRELATION_ID,
        environment: 'dev',
      },
    ]);
    expect(
      await ctx.changes.execute(ADMIN, { key: 'ENABLE_DYNAMIC_SURGE_PRICING', limit: 10 }),
    ).toHaveLength(1);
  });

  it('solo platform-admins puede escribir; sin identidad → UNAUTHORIZED', async () => {
    const ctx = context();
    await expect(ctx.update.execute(OPERATOR, command())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ctx.update.execute(undefined, command())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(
      ctx.changes.execute(OPERATOR, { key: 'ENABLE_DYNAMIC_SURGE_PRICING', limit: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(ctx.flags.audit).toHaveLength(0);
  });

  it('valida la clave: formato y pertenencia al catálogo', async () => {
    const ctx = context();
    await expect(ctx.update.execute(ADMIN, command({ key: 'drop table' }))).rejects.toBeInstanceOf(
      InvalidValueError,
    );
    await expect(
      ctx.update.execute(ADMIN, command({ key: 'ENABLE_FREE_CHARGING' })),
    ).rejects.toBeInstanceOf(FeatureFlagNotFoundError);
  });

  it('fijar el valor que ya tiene no escribe ni audita (idempotente)', async () => {
    const ctx = context('dev');

    const result = await ctx.update.execute(ADMIN, command({ enabled: true }));

    expect(result.changed).toBe(false);
    expect(result.flag.version).toBe(1);
    expect(ctx.flags.audit).toHaveLength(0);
  });

  it('expectedVersion distinta → FEATURE_FLAG_VERSION_CONFLICT sin escribir', async () => {
    const ctx = context('dev');

    await expect(ctx.update.execute(ADMIN, command({ expectedVersion: 7 }))).rejects.toBeInstanceOf(
      FeatureFlagVersionConflictError,
    );
    expect(ctx.flags.audit).toHaveLength(0);
  });

  it('escritura concurrente: sin versión esperada se relee y reintenta; con versión, conflicto', async () => {
    const ctx = context('dev');
    let stolen = false;
    ctx.flags.beforeSave = () => {
      if (!stolen) {
        stolen = true;
        const current = ctx.flags.flags.get('ENABLE_DYNAMIC_SURGE_PRICING');
        if (current !== undefined) {
          ctx.flags.flags.set(
            current.key,
            FeatureFlag.restore({
              key: current.key,
              enabled: current.enabled,
              description: current.description,
              version: current.version + 1,
              updatedBy: ActorId.parse('other-admin'),
              updatedAt: START,
            }),
          );
        }
      }
    };

    const retried = await ctx.update.execute(ADMIN, command());
    expect(retried.flag.version).toBe(3);

    stolen = false;
    await expect(
      ctx.update.execute(ADMIN, command({ enabled: true, expectedVersion: 3 })),
    ).rejects.toBeInstanceOf(FeatureFlagVersionConflictError);
  });

  it('invalida la caché local: la siguiente lectura ya ve el cambio', async () => {
    const ctx = context('dev', 60_000);
    expect(valueOf(await ctx.get.execute(ADMIN), 'SIMULATE_CHARGER_HARDWARE_FAULT')?.enabled).toBe(
      false,
    );

    await ctx.update.execute(
      ADMIN,
      command({ key: 'SIMULATE_CHARGER_HARDWARE_FAULT', enabled: true }),
    );

    expect(valueOf(await ctx.get.execute(ADMIN), 'SIMULATE_CHARGER_HARDWARE_FAULT')?.enabled).toBe(
      true,
    );
  });

  it('una flag no sembrada no se crea implícitamente → FEATURE_FLAG_NOT_FOUND', async () => {
    const ctx = context('dev');
    ctx.flags.flags.delete('ENABLE_FAST_CHARGE_BOOST');

    await expect(
      ctx.update.execute(ADMIN, command({ key: 'ENABLE_FAST_CHARGE_BOOST' })),
    ).rejects.toBeInstanceOf(FeatureFlagNotFoundError);
  });

  it('un cambio en el ambiente dev no toca el repositorio de prod (instancias por ambiente)', async () => {
    const dev = context('dev');
    const prod = context('prod');

    await dev.update.execute(ADMIN, command({ enabled: false }));

    expect(dev.flags.flags.get('ENABLE_DYNAMIC_SURGE_PRICING')?.enabled).toBe(false);
    expect(prod.flags.flags.get('ENABLE_DYNAMIC_SURGE_PRICING')).toMatchObject({
      enabled: false,
      version: 1,
    });
    expect(prod.flags.audit).toHaveLength(0);
    expect(FeatureFlagKey.parse('ENABLE_DYNAMIC_SURGE_PRICING')).toBeDefined();
  });
});
