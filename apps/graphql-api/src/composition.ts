import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  CatalogQueries,
  FleetQueries,
  FlagSnapshotCache,
  GetFeatureFlags,
  ListFeatureFlagChanges,
  ReleaseReservation,
  ReserveAndActivateCharging,
  StopChargingSession,
  UpdateFeatureFlag,
  type Clock,
  type DeploymentEnvironment,
  type Upstreams,
} from './application/index.ts';
import { DynamoDbFeatureFlagRepository } from './infrastructure/dynamodb/dynamodb-feature-flag-repository.ts';

/**
 * Casos de uso del módulo de flags ligados a la tabla y al ambiente del
 * despliegue. Lectura y escritura comparten la caché para que la réplica que
 * escribe vea su cambio de inmediato.
 */
export function createFlagUseCases(deps: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  environment: DeploymentEnvironment;
  cacheTtlMs: number;
  clock: Clock;
}) {
  const flags = new DynamoDbFeatureFlagRepository(deps.documentClient, deps.tableName);
  const cache = new FlagSnapshotCache({ ttlMs: deps.cacheTtlMs, clock: deps.clock });
  const shared = { flags, cache, clock: deps.clock, environment: deps.environment };
  return {
    getFeatureFlags: new GetFeatureFlags(shared),
    updateFeatureFlag: new UpdateFeatureFlag(shared),
    listFeatureFlagChanges: new ListFeatureFlagChanges({ flags }),
  };
}

/** Casos de uso del BFF que delegan en los servicios (sin persistencia propia de negocio). */
export function createBffUseCases(upstreams: Upstreams) {
  return {
    catalog: new CatalogQueries({ upstreams }),
    fleet: new FleetQueries({ upstreams }),
    reserveAndActivateCharging: new ReserveAndActivateCharging({ upstreams }),
    releaseReservation: new ReleaseReservation({ upstreams }),
    stopChargingSession: new StopChargingSession({ upstreams }),
  };
}
