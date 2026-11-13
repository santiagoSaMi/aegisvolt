import { hostname } from 'node:os';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  GetSaga,
  ListFleetSagas,
  ListSagaEvents,
  RecoverPendingSagas,
  ReserveAndActivateCharging,
  RetryCompensation,
  SagaExecutor,
  type Clock,
  type IdGenerator,
  type RecoveryOptions,
  type SagaObserver,
  type SagaParticipants,
  type Sleep,
} from './application/index.ts';
import type { RetryConfig } from './config.ts';
import { RetryPolicy } from './domain/index.ts';
import { DynamoDbSagaRepository } from './infrastructure/dynamodb/dynamodb-saga-repository.ts';

export interface CompositionDeps {
  readonly documentClient: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly participants: SagaParticipants;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly observer: SagaObserver;
  readonly saga: {
    readonly forward: RetryConfig;
    readonly compensationAttempts: RetryConfig;
    readonly compensationRounds: RetryConfig;
    readonly leaseMs: number;
  };
  readonly recovery: RecoveryOptions;
  /** Identidad de la réplica (dueño del *lease*). Por defecto, host + pid. */
  readonly owner?: string;
}

const policy = (config: RetryConfig) => new RetryPolicy({ ...config, multiplier: 2 });

/** Cableado de casos de uso; lo usan `main.ts`, el comando de recuperación y las pruebas. */
export function createUseCases(deps: CompositionDeps) {
  const sagas = new DynamoDbSagaRepository(deps.documentClient, deps.tableName);
  const executor = new SagaExecutor({
    sagas,
    participants: deps.participants,
    clock: deps.clock,
    sleep: deps.sleep,
    random: deps.random,
    observer: deps.observer,
    owner: deps.owner ?? `${hostname()}:${String(process.pid)}`,
    policy: {
      forward: policy(deps.saga.forward),
      compensationAttempts: policy(deps.saga.compensationAttempts),
      compensationRounds: new RetryPolicy({ ...deps.saga.compensationRounds, multiplier: 3 }),
      leaseMs: deps.saga.leaseMs,
    },
  });
  const { clock } = deps;
  return {
    reserveAndActivateCharging: new ReserveAndActivateCharging({
      sagas,
      executor,
      clock,
      ids: deps.ids,
      observer: deps.observer,
    }),
    retryCompensation: new RetryCompensation({ sagas, executor, clock }),
    recoverPendingSagas: new RecoverPendingSagas({
      sagas,
      executor,
      clock,
      options: deps.recovery,
    }),
    getSaga: new GetSaga({ sagas }),
    listSagaEvents: new ListSagaEvents({ sagas }),
    listFleetSagas: new ListFleetSagas({ sagas }),
  };
}

export type UseCases = ReturnType<typeof createUseCases>;
