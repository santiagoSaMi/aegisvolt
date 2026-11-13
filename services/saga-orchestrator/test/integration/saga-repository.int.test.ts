import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConcurrentModificationError,
  RecoverPendingSagas,
  ReserveAndActivateCharging,
  SagaAlreadyExistsError,
  SagaExecutor,
} from '../../src/application/index.ts';
import {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  ReservationId,
  RetryPolicy,
  SagaId,
  SagaTransaction,
  SessionId,
  StationId,
} from '../../src/domain/index.ts';
import { DynamoDbSagaRepository } from '../../src/infrastructure/dynamodb/dynamodb-saga-repository.ts';
import { GSI2, keys } from '../../src/infrastructure/dynamodb/table.ts';
import { FakeParticipants } from '../support/fake-participants.ts';
import {
  CORRELATION_ID,
  FixedClock,
  RECOVERY,
  RecordingObserver,
  START,
  SequentialIds,
  command,
  uuid,
} from '../support/fixtures.ts';
import {
  FLOCI_ENDPOINT,
  createClients,
  createTemporaryTable,
  deleteTable,
  flociAvailable,
} from './floci.ts';

describe.skipIf(!flociAvailable)(
  `saga-orchestrator contra DynamoDB de Floci (${FLOCI_ENDPOINT})`,
  () => {
    const clients = createClients();
    let tableName: string;
    let repo: DynamoDbSagaRepository;

    const raw = async (key: { PK: string; SK: string }) =>
      (
        await clients.documentClient.send(
          new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
        )
      ).Item as Record<string, unknown> | undefined;
    const eventItems = async (sagaId: string) =>
      ((
        await clients.documentClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :evt)',
            ExpressionAttributeValues: { ':pk': keys.sagaPartition(sagaId), ':evt': 'EVT#' },
            ConsistentRead: true,
          }),
        )
      ).Items ?? []) as Record<string, unknown>[];

    const newSaga = (n: number) =>
      SagaTransaction.start({
        id: SagaId.parse(`saga_${uuid(n)}`),
        idempotencyKey: uuid(n),
        request: {
          fleetId: FleetId.parse('fleet_it'),
          stationId: StationId.parse('st_it-01'),
          connectorId: ConnectorId.parse('cn_01'),
          requestedEnergyKwh: 30,
          fastChargeBoost: false,
        },
        resources: {
          reservationId: ReservationId.parse(`res_${uuid(n)}`),
          debitId: DebitId.parse(`dbt_${uuid(n)}`),
          sessionId: SessionId.parse(`ses_${uuid(n)}`),
        },
        operationKeys: {
          CONFIRMATION: uuid(n + 1000),
          ABORT_SESSION: uuid(n + 2000),
          REFUND_DEBIT: uuid(n + 3000),
          RELEASE_RESERVATION: uuid(n + 4000),
        },
        correlationId: CorrelationId.parse(CORRELATION_ID),
        now: START,
      });
    const lease = (owner: string, ms = 30_000) => ({
      owner,
      expiresAt: new Date(START.getTime() + ms),
    });

    /** Orquestador completo (casos de uso reales) sobre la tabla de Floci. */
    function orchestrator(participants: FakeParticipants, owner: string, clock: FixedClock) {
      const executor = new SagaExecutor({
        sagas: repo,
        participants: participants.build(),
        clock,
        sleep: (ms) => {
          clock.advance(ms);
          return Promise.resolve();
        },
        random: () => 0.5,
        observer: new RecordingObserver(),
        owner,
        policy: {
          forward: new RetryPolicy({
            maxAttempts: 3,
            baseDelayMs: 10,
            maxDelayMs: 50,
            multiplier: 2,
          }),
          compensationAttempts: new RetryPolicy({
            maxAttempts: 3,
            baseDelayMs: 10,
            maxDelayMs: 50,
            multiplier: 2,
          }),
          compensationRounds: new RetryPolicy({
            maxAttempts: 3,
            baseDelayMs: 1_000,
            maxDelayMs: 5_000,
            multiplier: 3,
          }),
          leaseMs: 30_000,
        },
      });
      return {
        start: new ReserveAndActivateCharging({
          sagas: repo,
          executor,
          clock,
          ids: new SequentialIds(),
          observer: new RecordingObserver(),
        }),
        recover: new RecoverPendingSagas({ sagas: repo, executor, clock, options: RECOVERY }),
      };
    }

    beforeAll(async () => {
      tableName = await createTemporaryTable(clients);
      repo = new DynamoDbSagaRepository(clients.documentClient, tableName);
    });

    afterAll(async () => {
      await deleteTable(clients, tableName).catch(() => undefined);
      clients.client.destroy();
    });

    it('crea SAGA + evento en una transacción; una segunda creación con el mismo id falla', async () => {
      const saga = newSaga(1);
      await repo.create(saga, lease('a'));

      expect(await raw(keys.saga(saga.id))).toMatchObject({
        status: 'STARTED',
        version: 1,
        leaseOwner: 'a',
        correlationId: CORRELATION_ID,
        reservationId: `res_${uuid(1)}`,
        GSI2PK: 'STATUS#STARTED',
      });
      expect(await eventItems(saga.id)).toHaveLength(1);
      await expect(repo.create(saga, lease('b'))).rejects.toBeInstanceOf(SagaAlreadyExistsError);
    });

    it('save exige versión leída Y lease propio; si falla no escribe estado ni eventos', async () => {
      const saga = newSaga(2);
      await repo.create(saga, lease('a'));
      const next = saga.withoutPendingEvents().beginStep(new Date(START.getTime() + 1));

      await expect(repo.save(next, 7, lease('a'))).rejects.toBeInstanceOf(
        ConcurrentModificationError,
      );
      await expect(repo.save(next, 1, lease('intruso'))).rejects.toBeInstanceOf(
        ConcurrentModificationError,
      );
      expect((await raw(keys.saga(saga.id)))?.version).toBe(1);
      expect(await eventItems(saga.id)).toHaveLength(1);

      expect(await repo.save(next, 1, lease('a'))).toBe(2);
      expect(await eventItems(saga.id)).toHaveLength(2);
    });

    it('lease: solo se toma libre, vencido o propio', async () => {
      const saga = newSaga(3);
      await repo.create(saga, lease('a', 30_000));
      const now = new Date(START.getTime() + 1_000);

      expect(await repo.acquireLease(saga.id, lease('b'), now)).toBe(false);
      expect(await repo.acquireLease(saga.id, lease('a', 60_000), now)).toBe(true);
      const later = new Date(START.getTime() + 61_000);
      expect(await repo.acquireLease(saga.id, lease('b', 90_000), later)).toBe(true);
      expect((await raw(keys.saga(saga.id)))?.leaseOwner).toBe('b');
      await repo.releaseLease(saga.id, 'a'); // no es suyo: no hace nada
      expect((await raw(keys.saga(saga.id)))?.leaseOwner).toBe('b');
      await repo.releaseLease(saga.id, 'b');
      expect((await raw(keys.saga(saga.id)))?.leaseOwner).toBeUndefined();
    });

    it('fallo de hardware: SAGA COMPENSATED e historial completo en DynamoDB', async () => {
      const participants = new FakeParticipants().respond('activateSession', {
        kind: 'REJECTED',
        code: 'CHARGER_HARDWARE_FAULT',
      });
      const clock = new FixedClock(START);
      const { saga } = await orchestrator(participants, 'a', clock).start.execute(
        command({ idempotencyKey: uuid(10), fleetId: 'fleet_it' }),
      );

      const item = await raw(keys.saga(saga.id));
      expect(item).toMatchObject({
        status: 'COMPENSATED',
        failureReason: 'CHARGER_HARDWARE_FAULT',
        failedStep: 'ACTIVATION',
        compensationPlan: ['REFUND_DEBIT', 'RELEASE_RESERVATION'],
        GSI2PK: 'STATUS#COMPENSATED',
      });
      expect(item?.leaseOwner).toBeUndefined();
      const types = (await eventItems(saga.id)).map(
        (e) => `${e.type as string}:${typeof e.step === 'string' ? e.step : ''}`,
      );
      expect(types).toEqual([
        'SAGA_STARTED:',
        'STEP_STARTED:RESERVATION',
        'STEP_SUCCEEDED:RESERVATION',
        'STEP_STARTED:DEBIT',
        'STEP_SUCCEEDED:DEBIT',
        'STEP_STARTED:ACTIVATION',
        'STEP_FAILED:ACTIVATION',
        'COMPENSATION_STARTED:',
        'COMPENSATION_STEP_STARTED:REFUND_DEBIT',
        'COMPENSATION_SUCCEEDED:REFUND_DEBIT',
        'COMPENSATION_STEP_STARTED:RELEASE_RESERVATION',
        'COMPENSATION_SUCCEEDED:RELEASE_RESERVATION',
        'SAGA_COMPENSATED:',
      ]);
      expect(new Set((await eventItems(saga.id)).map((e) => e.correlationId))).toEqual(
        new Set([CORRELATION_ID]),
      );
    });

    it('reinicio: la recuperación encuentra la SAGA por el índice de estado y la termina', async () => {
      const participants = new FakeParticipants();
      participants.onCall = (operation) => {
        if (operation === 'activateSession') {
          participants.onCall = undefined;
          throw new Error('el pod murió');
        }
      };
      const clock = new FixedClock(START);
      const key = uuid(20);
      await expect(
        orchestrator(participants, 'pod-1', clock).start.execute(
          command({ idempotencyKey: key, fleetId: 'fleet_it' }),
        ),
      ).rejects.toThrow('murió');
      const sagaId = `saga_${key}`;
      expect(await raw(keys.saga(sagaId))).toMatchObject({
        status: 'BILLING_COMPLETED',
        steps: { ACTIVATION: { status: 'IN_PROGRESS', attempts: 1 } },
        leaseOwner: 'pod-1',
      });
      const pending = await clients.documentClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: GSI2,
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': 'STATUS#BILLING_COMPLETED' },
        }),
      );
      expect((pending.Items ?? []).map((i) => i.sagaId as string)).toContain(sagaId);

      clock.advance(45_000); // lease vencido y SAGA inactiva
      const report = await orchestrator(participants, 'pod-2', clock).recover.execute();

      expect(report.recovered).toContainEqual({
        sagaId,
        from: 'BILLING_COMPLETED',
        to: 'COMPLETED',
      });
      // (La recuperación también retoma las SAGAs abandonadas de pruebas anteriores.)
      const activations = participants
        .callsTo('activateSession')
        .filter((c) => c.ctx.sagaId === sagaId);
      expect(activations.map((c) => c.ctx.idempotencyKey)).toEqual([`ses_${key}`, `ses_${key}`]);
      const types = (await eventItems(sagaId)).map((e) => e.type);
      expect(types).toContain('RECOVERED');
      expect((await raw(keys.saga(sagaId)))?.status).toBe('COMPLETED');
    });

    it('dos réplicas recuperan a la vez: solo una ejecuta la SAGA', async () => {
      const participants = new FakeParticipants();
      participants.onCall = (operation) => {
        if (operation === 'debit') {
          participants.onCall = undefined;
          throw new Error('caída');
        }
      };
      const clock = new FixedClock(START);
      const key = uuid(30);
      await expect(
        orchestrator(participants, 'pod-1', clock).start.execute(
          command({ idempotencyKey: key, fleetId: 'fleet_it' }),
        ),
      ).rejects.toThrow();
      clock.advance(45_000);

      const reports = await Promise.all([
        orchestrator(participants, 'pod-2', clock).recover.execute(),
        orchestrator(participants, 'pod-3', clock).recover.execute(),
      ]);

      const recoveredBy = reports.filter((r) =>
        r.recovered.some((x) => x.sagaId === `saga_${key}`),
      );
      expect(recoveredBy).toHaveLength(1);
      expect(
        participants.callsTo('debit').filter((c) => c.ctx.sagaId === `saga_${key}`),
      ).toHaveLength(2);
    });
  },
);
