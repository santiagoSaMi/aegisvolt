import {
  energyDispatchV1,
  featureFlagsV1,
  sagaOrchestratorV1,
  stationReservationV1,
} from '@aegisvolt/contracts';
import { buildSchema, isEnumType, isObjectType, isInputObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';

import { resolvers } from '../../src/presentation/graphql/resolvers.ts';
import { typeDefs } from '../../src/presentation/graphql/schema.ts';

const schema = buildSchema(typeDefs);

describe('esquema GraphQL', () => {
  it('expone exactamente las queries y mutaciones requeridas', () => {
    expect(Object.keys(schema.getQueryType()?.getFields() ?? {}).sort()).toEqual(
      [
        'stations',
        'stationById',
        'availableConnectors',
        'walletBalance',
        'chargingSessions',
        'chargingSessionById',
        'reservations',
        'transactions',
        'sagaStatus',
        'featureFlags',
        'viewer',
        'chargingEstimate',
        'sagas',
        'systemStatus',
      ].sort(),
    );
    expect(Object.keys(schema.getMutationType()?.getFields() ?? {}).sort()).toEqual(
      [
        'reserveAndActivateCharging',
        'releaseReservation',
        'stopChargingSession',
        'updateFeatureFlag',
      ].sort(),
    );
  });

  it('cada query y mutación tiene su resolver (y viceversa)', () => {
    expect(Object.keys(resolvers.Query).sort()).toEqual(
      Object.keys(schema.getQueryType()?.getFields() ?? {}).sort(),
    );
    expect(Object.keys(resolvers.Mutation).sort()).toEqual(
      Object.keys(schema.getMutationType()?.getFields() ?? {}).sort(),
    );
  });

  it('está documentado: cada operación raíz, tipo de objeto y enum tiene descripción', () => {
    const undocumented: string[] = [];
    for (const root of [schema.getQueryType(), schema.getMutationType()]) {
      for (const field of Object.values(root?.getFields() ?? {})) {
        if (!field.description) {
          undocumented.push(`${root?.name ?? ''}.${field.name}`);
        }
      }
    }
    for (const type of Object.values(schema.getTypeMap())) {
      const own =
        !type.name.startsWith('__') &&
        !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(type.name);
      const needsDoc =
        isEnumType(type) ||
        (isObjectType(type) &&
          !['Query', 'Mutation'].includes(type.name) &&
          !type.name.endsWith('Connection') &&
          !type.name.endsWith('Payload'));
      if (own && needsDoc && !type.description && !isInputObjectType(type)) {
        undocumented.push(type.name);
      }
    }
    expect(undocumented).toEqual([]);
  });

  it('los enums coinciden con el vocabulario de los contratos', () => {
    const values = (name: string) => {
      const type = schema.getType(name);
      return isEnumType(type)
        ? type
            .getValues()
            .map((v) => v.name)
            .sort()
        : [];
    };
    expect(values('SagaStatus')).toEqual([...sagaOrchestratorV1.SAGA_STATUSES].sort());
    expect(values('ReservationStatus')).toEqual(
      [...new Set([...stationReservationV1.RESERVATION_STATUSES, 'VOIDED'])].sort(),
    );
    expect(values('ChargingSessionStatus')).toEqual([...energyDispatchV1.SESSION_STATUSES].sort());
    expect(values('FeatureFlagSource')).toEqual([...featureFlagsV1.FEATURE_FLAG_SOURCES].sort());
    expect(values('Environment')).toEqual([...featureFlagsV1.FLAG_ENVIRONMENTS].sort());
  });

  it('ninguna operación acepta un ambiente como argumento', () => {
    for (const root of [schema.getQueryType(), schema.getMutationType()]) {
      for (const field of Object.values(root?.getFields() ?? {})) {
        expect(field.args.map((a) => a.name)).not.toContain('environment');
      }
    }
  });
});
