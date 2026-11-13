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
} from '../../src/application/index.ts';
import { RetryPolicy, type SagaEvent, type SagaTransaction } from '../../src/domain/index.ts';
import { FakeParticipants } from './fake-participants.ts';
import { InMemorySagaRepository } from './in-memory-saga-repository.ts';

export const START = new Date('2026-11-13T15:00:00.000Z');
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const KEY = uuid(1);
export const SAGA_ID = `saga_${KEY}`;
export const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';

export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private next = 100;

  uuid(): string {
    return uuid(this.next++);
  }
}

export class RecordingObserver implements SagaObserver {
  readonly events: SagaEvent[] = [];

  transitioned(_saga: SagaTransaction, events: readonly SagaEvent[]): void {
    this.events.push(...events);
  }
}

export const command = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: KEY,
  correlationId: CORRELATION_ID,
  fleetId: 'fleet_001',
  stationId: 'st_bog-norte-01',
  connectorId: 'cn_01',
  requestedEnergyKwh: 30,
  fastChargeBoost: false,
  ...overrides,
});

export const RECOVERY: RecoveryOptions = {
  staleAfterMs: 15_000,
  forwardDeadlineMs: 60_000,
  batchSize: 25,
};

/**
 * Orquestador completo sobre el repositorio en memoria y participantes falsos.
 * Varias "réplicas" comparten el mismo repositorio con distinto `owner`.
 */
export function createContext(options: { participants?: FakeParticipants } = {}) {
  const sagas = new InMemorySagaRepository();
  const participants = options.participants ?? new FakeParticipants();
  const clock = new FixedClock(START);
  const observer = new RecordingObserver();
  const sleeps: number[] = [];

  const replica = (owner: string) => {
    const executor = new SagaExecutor({
      sagas,
      participants: participants.build(),
      clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      observer,
      owner,
      policy: {
        forward: new RetryPolicy({
          maxAttempts: 3,
          baseDelayMs: 200,
          maxDelayMs: 2_000,
          multiplier: 2,
        }),
        compensationAttempts: new RetryPolicy({
          maxAttempts: 3,
          baseDelayMs: 200,
          maxDelayMs: 2_000,
          multiplier: 2,
        }),
        compensationRounds: new RetryPolicy({
          maxAttempts: 3,
          baseDelayMs: 5_000,
          maxDelayMs: 60_000,
          multiplier: 3,
        }),
        leaseMs: 30_000,
      },
    });
    return {
      executor,
      reserveAndActivateCharging: new ReserveAndActivateCharging({
        sagas,
        executor,
        clock,
        ids: new SequentialIds(),
        observer,
      }),
      retryCompensation: new RetryCompensation({ sagas, executor, clock }),
      recoverPendingSagas: new RecoverPendingSagas({ sagas, executor, clock, options: RECOVERY }),
      getSaga: new GetSaga({ sagas }),
      listSagaEvents: new ListSagaEvents({ sagas }),
      listFleetSagas: new ListFleetSagas({ sagas }),
    };
  };

  return { sagas, participants, clock, observer, sleeps, replica, ...replica('replica-a') };
}
