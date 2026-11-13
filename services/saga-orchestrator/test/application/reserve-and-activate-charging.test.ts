import { describe, expect, it } from 'vitest';

import { SagaBusyError } from '../../src/application/index.ts';
import {
  IdempotencyKeyConflictError,
  SagaNotRetryableError,
  type SagaId,
} from '../../src/domain/index.ts';
import { FakeParticipants } from '../support/fake-participants.ts';
import { CORRELATION_ID, KEY, SAGA_ID, command, createContext } from '../support/fixtures.ts';

const sagaId = SAGA_ID as SagaId;

describe('Flujo exitoso', () => {
  it('reserva → débito → activación → confirmación → COMPLETED, persistiendo cada transición', async () => {
    const ctx = createContext();

    const { saga, created } = await ctx.reserveAndActivateCharging.execute(command());

    expect(created).toBe(true);
    expect(saga.status).toBe('COMPLETED');
    expect(ctx.participants.operations).toEqual([
      'getConnectorPower',
      'holdReservation',
      'debit',
      'activateSession',
      'confirmReservation',
    ]);
    expect(ctx.sagas.statusLog.get(SAGA_ID)).toEqual([
      'STARTED', // creación
      'STARTED', // RESERVATION IN_PROGRESS (antes de llamar)
      'RESERVATION_COMPLETED',
      'RESERVATION_COMPLETED', // DEBIT IN_PROGRESS
      'BILLING_COMPLETED',
      'BILLING_COMPLETED', // ACTIVATION IN_PROGRESS
      'DISPATCH_COMPLETED',
      'DISPATCH_COMPLETED', // CONFIRMATION IN_PROGRESS
      'COMPLETED',
    ]);
    // Lease liberado al terminar.
    expect(ctx.sagas.rows.get(SAGA_ID)?.lease).toBeUndefined();
  });

  it('persiste el paso IN_PROGRESS ANTES de cada llamada', async () => {
    const participants = new FakeParticipants();
    const ctx = createContext({ participants });
    const seen: string[] = [];
    participants.onCall = (operation) => {
      const steps = ctx.sagas.rows.get(SAGA_ID)?.saga.steps ?? {};
      const inProgress = Object.entries(steps)
        .filter(([, state]) => state.status === 'IN_PROGRESS')
        .map(([step]) => step);
      seen.push(`${operation}:${inProgress.join(',')}`);
    };

    await ctx.reserveAndActivateCharging.execute(command());

    expect(seen).toEqual([
      'getConnectorPower:RESERVATION',
      'holdReservation:RESERVATION',
      'debit:DEBIT',
      'activateSession:ACTIVATION',
      'confirmReservation:CONFIRMATION',
    ]);
  });

  it('propaga correlation_id, saga_id y claves idempotentes estables a cada servicio', async () => {
    const ctx = createContext();
    await ctx.reserveAndActivateCharging.execute(command());

    for (const call of ctx.participants.calls) {
      expect(call.ctx).toMatchObject({ correlationId: CORRELATION_ID, sagaId: SAGA_ID });
    }
    expect(ctx.participants.callsTo('holdReservation')[0]?.ctx.idempotencyKey).toBe(`res_${KEY}`);
    expect(ctx.participants.callsTo('debit')[0]?.ctx.idempotencyKey).toBe(`dbt_${KEY}`);
    expect(ctx.participants.callsTo('activateSession')[0]?.ctx.idempotencyKey).toBe(`ses_${KEY}`);
    // La potencia del conector se guarda en la SAGA y se usa para el débito.
    expect(ctx.participants.callsTo('debit')[0]?.args[0]).toMatchObject({ connectorPowerKw: 60 });
    const events = ctx.sagas.events.get(SAGA_ID) ?? [];
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, index) => index));
  });
});

describe('Fondos insuficientes', () => {
  it('libera la reserva (y no reembolsa nada) → COMPENSATED', async () => {
    const participants = new FakeParticipants().respond('debit', {
      kind: 'REJECTED',
      code: 'INSUFFICIENT_FUNDS',
    });
    const ctx = createContext({ participants });

    const { saga } = await ctx.reserveAndActivateCharging.execute(command());

    expect(saga).toMatchObject({
      status: 'COMPENSATED',
      failureReason: 'INSUFFICIENT_FUNDS',
      failedStep: 'DEBIT',
      compensationPlan: ['RELEASE_RESERVATION'],
    });
    expect(ctx.participants.operations).toEqual([
      'getConnectorPower',
      'holdReservation',
      'debit',
      'releaseReservation',
    ]);
    // Rechazo de negocio: el débito NO se reintenta.
    expect(ctx.participants.callsTo('debit')).toHaveLength(1);
    expect(ctx.participants.callsTo('releaseReservation')[0]?.args[1]).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('Fallo de hardware', () => {
  it('reembolsa el débito y DESPUÉS libera la reserva → COMPENSATED', async () => {
    const participants = new FakeParticipants().respond('activateSession', {
      kind: 'REJECTED',
      code: 'CHARGER_HARDWARE_FAULT',
    });
    const ctx = createContext({ participants });

    const { saga } = await ctx.reserveAndActivateCharging.execute(command());

    expect(saga).toMatchObject({
      status: 'COMPENSATED',
      failureReason: 'CHARGER_HARDWARE_FAULT',
      compensationPlan: ['REFUND_DEBIT', 'RELEASE_RESERVATION'],
    });
    expect(ctx.participants.operations.slice(-2)).toEqual(['refundDebit', 'releaseReservation']);
    expect(ctx.participants.callsTo('abortSession')).toHaveLength(0);
    expect(ctx.participants.callsTo('activateSession')).toHaveLength(1);
    const types = (ctx.sagas.events.get(SAGA_ID) ?? []).map((e) => e.type);
    expect(types.slice(-6)).toEqual([
      'COMPENSATION_STARTED',
      'COMPENSATION_STEP_STARTED',
      'COMPENSATION_SUCCEEDED',
      'COMPENSATION_STEP_STARTED',
      'COMPENSATION_SUCCEEDED',
      'SAGA_COMPENSATED',
    ]);
  });

  it('una activación con resultado desconocido se verifica antes de compensar (pivote)', async () => {
    const active = new FakeParticipants()
      .failTransiently('activateSession', 3, 'TIMEOUT')
      .respond('getSession', { kind: 'OK', value: { status: 'ACTIVE' } });
    const ok = createContext({ participants: active });
    expect((await ok.reserveAndActivateCharging.execute(command())).saga.status).toBe('COMPLETED');

    const unknown = new FakeParticipants().failTransiently('activateSession', 3, 'TIMEOUT');
    const ko = createContext({ participants: unknown });
    const { saga } = await ko.reserveAndActivateCharging.execute(command());
    expect(saga).toMatchObject({
      status: 'COMPENSATED',
      failureReason: 'STEP_RETRIES_EXHAUSTED',
      compensationPlan: ['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION'],
    });
  });
});

describe('Repetición de la petición inicial', () => {
  it('devuelve la misma SAGA sin volver a llamar a los servicios', async () => {
    const ctx = createContext();
    const first = await ctx.reserveAndActivateCharging.execute(command());
    const calls = ctx.participants.calls.length;

    const second = await ctx.reserveAndActivateCharging.execute(
      command({ correlationId: '11111111-2222-4333-8444-555555555555' }),
    );

    expect(second.created).toBe(false);
    expect(second.saga.id).toBe(first.saga.id);
    expect(second.saga.correlationId).toBe(CORRELATION_ID);
    expect(ctx.participants.calls).toHaveLength(calls);
    expect(ctx.sagas.rows.size).toBe(1);
  });

  it('misma clave con otra petición → IDEMPOTENCY_KEY_CONFLICT', async () => {
    const ctx = createContext();
    await ctx.reserveAndActivateCharging.execute(command());

    await expect(
      ctx.reserveAndActivateCharging.execute(command({ requestedEnergyKwh: 31 })),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it('peticiones simultáneas con la misma clave: una sola SAGA y un solo débito', async () => {
    const ctx = createContext();

    const results = await Promise.all([
      ctx.reserveAndActivateCharging.execute(command()),
      ctx.replica('replica-b').reserveAndActivateCharging.execute(command()),
    ]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(ctx.sagas.rows.size).toBe(1);
    expect(ctx.participants.callsTo('debit')).toHaveLength(1);
  });

  it('una repetición retoma una SAGA abandonada (lease vencido) desde el paso persistido', async () => {
    const participants = new FakeParticipants();
    const ctx = createContext({ participants });
    participants.onCall = (operation) => {
      if (operation === 'activateSession') {
        participants.onCall = undefined;
        throw new Error('el proceso murió');
      }
    };
    await expect(ctx.reserveAndActivateCharging.execute(command())).rejects.toThrow('murió');
    ctx.sagas.expireLease(SAGA_ID);

    const { saga, created } = await ctx
      .replica('replica-b')
      .reserveAndActivateCharging.execute(command());

    expect(created).toBe(false);
    expect(saga.status).toBe('COMPLETED');
    expect(ctx.participants.callsTo('debit')).toHaveLength(1);
    expect((ctx.sagas.events.get(SAGA_ID) ?? []).map((e) => e.type)).toContain('RECOVERED');
  });
});

describe('Reinicio y reanudación', () => {
  it('con un paso intermedio persistido (DEBIT IN_PROGRESS) se reanuda con la MISMA clave', async () => {
    const participants = new FakeParticipants();
    const ctx = createContext({ participants });
    participants.onCall = (operation) => {
      if (operation === 'debit') {
        participants.onCall = undefined;
        throw new Error('SIGKILL a mitad del débito');
      }
    };
    await expect(ctx.reserveAndActivateCharging.execute(command())).rejects.toThrow('SIGKILL');

    const persisted = ctx.sagas.rows.get(SAGA_ID)?.saga;
    expect(persisted?.status).toBe('RESERVATION_COMPLETED');
    expect(persisted?.steps.DEBIT?.status).toBe('IN_PROGRESS');

    // "Reinicio": la réplica muere; otra la recupera cuando vence el lease y queda inactiva.
    ctx.sagas.expireLease(SAGA_ID);
    ctx.clock.advance(20_000);
    const report = await ctx.replica('replica-b').recoverPendingSagas.execute();

    expect(report.recovered).toEqual([
      { sagaId: SAGA_ID, from: 'RESERVATION_COMPLETED', to: 'COMPLETED' },
    ]);
    const debits = ctx.participants.callsTo('debit');
    expect(debits.map((call) => call.ctx.idempotencyKey)).toEqual([`dbt_${KEY}`, `dbt_${KEY}`]);
    // La reserva no se repite: ya estaba completada.
    expect(ctx.participants.callsTo('holdReservation')).toHaveLength(1);
    // La recuperación conserva el correlation_id original.
    expect(debits[1]?.ctx.correlationId).toBe(CORRELATION_ID);
  });

  it('no retoma una SAGA con lease vigente ni con actividad reciente', async () => {
    const participants = new FakeParticipants();
    const ctx = createContext({ participants });
    participants.onCall = (operation) => {
      if (operation === 'debit') {
        participants.onCall = undefined;
        throw new Error('caída');
      }
    };
    await expect(ctx.reserveAndActivateCharging.execute(command())).rejects.toThrow();

    expect((await ctx.replica('replica-b').recoverPendingSagas.execute()).recovered).toEqual([]);
    ctx.clock.advance(20_000); // inactiva, pero el lease (30 s) sigue vigente
    expect((await ctx.replica('replica-b').recoverPendingSagas.execute()).recovered).toEqual([]);
    ctx.clock.advance(15_000); // lease vencido
    expect((await ctx.replica('replica-b').recoverPendingSagas.execute()).recovered).toHaveLength(
      1,
    );
  });

  it('antes del pivote y fuera de plazo, compensa en vez de avanzar', async () => {
    const participants = new FakeParticipants();
    const ctx = createContext({ participants });
    participants.onCall = (operation) => {
      if (operation === 'debit') {
        participants.onCall = undefined;
        throw new Error('caída');
      }
    };
    await expect(ctx.reserveAndActivateCharging.execute(command())).rejects.toThrow();
    ctx.clock.advance(70_000);

    await ctx.replica('replica-b').recoverPendingSagas.execute();

    const saga = ctx.sagas.rows.get(SAGA_ID)?.saga;
    expect(saga).toMatchObject({
      status: 'COMPENSATED',
      failureReason: 'RECOVERY_DEADLINE_EXCEEDED',
      compensationPlan: ['REFUND_DEBIT', 'RELEASE_RESERVATION'],
    });
    // El débito de resultado desconocido se compensa (refund idempotente o tombstone).
    expect(ctx.participants.callsTo('refundDebit')[0]?.args[1]).toBe('RECOVERY_DEADLINE_EXCEEDED');
  });
});

describe('Repetición de una compensación', () => {
  it('si el proceso muere tras liberar, la liberación se repite con la MISMA clave y se acepta ALREADY_RELEASED', async () => {
    const participants = new FakeParticipants()
      .respond('debit', { kind: 'REJECTED', code: 'INSUFFICIENT_FUNDS' })
      .respond(
        'releaseReservation',
        { kind: 'OK', value: { status: 'RELEASED', outcome: 'RELEASED' } },
        { kind: 'OK', value: { status: 'RELEASED', outcome: 'ALREADY_RELEASED' } },
      );
    const ctx = createContext({ participants });
    // Se cae justo después de que el servicio liberó, antes de persistirlo.
    let crashed = false;
    ctx.sagas.beforeSave = (saga) => {
      if (!crashed && saga.steps.RELEASE_RESERVATION?.status === 'SUCCEEDED') {
        crashed = true;
        throw new Error('caída tras la compensación');
      }
    };
    await expect(ctx.reserveAndActivateCharging.execute(command())).rejects.toThrow('caída');
    expect(ctx.sagas.rows.get(SAGA_ID)?.saga.status).toBe('COMPENSATING');

    ctx.sagas.expireLease(SAGA_ID);
    ctx.clock.advance(20_000);
    await ctx.replica('replica-b').recoverPendingSagas.execute();

    const releases = ctx.participants.callsTo('releaseReservation');
    expect(releases).toHaveLength(2);
    expect(new Set(releases.map((call) => call.ctx.idempotencyKey)).size).toBe(1);
    expect(ctx.sagas.rows.get(SAGA_ID)?.saga.status).toBe('COMPENSATED');
  });

  it('una compensación ya verificada no se vuelve a ejecutar al reintentar la siguiente', async () => {
    const participants = new FakeParticipants()
      .respond('activateSession', { kind: 'REJECTED', code: 'CHARGER_HARDWARE_FAULT' })
      .respond('releaseReservation', { kind: 'REJECTED', code: 'RESERVATION_MISMATCH' });
    const ctx = createContext({ participants });
    await ctx.reserveAndActivateCharging.execute(command());

    await ctx.retryCompensation.execute(SAGA_ID);

    expect(ctx.participants.callsTo('refundDebit')).toHaveLength(1);
    expect(ctx.participants.callsTo('releaseReservation')).toHaveLength(2);
    expect(ctx.sagas.rows.get(SAGA_ID)?.saga.status).toBe('COMPENSATED');
  });
});

describe('Fallo durante la compensación', () => {
  it('transitorio: COMPENSATION_FAILED con paso, error y reintento programado; el worker la termina', async () => {
    const participants = new FakeParticipants()
      .respond('activateSession', { kind: 'REJECTED', code: 'CHARGER_HARDWARE_FAULT' })
      .failTransiently('refundDebit', 3, 'HTTP_503');
    const ctx = createContext({ participants });

    const { saga } = await ctx.reserveAndActivateCharging.execute(command());

    expect(saga.status).toBe('COMPENSATION_FAILED');
    expect(saga.compensationFailure).toMatchObject({
      step: 'REFUND_DEBIT',
      errorCode: 'HTTP_503',
      round: 1,
    });
    expect(saga.compensationFailure?.nextAttemptAt).toBeInstanceOf(Date);
    // No se libera la reserva antes de reembolsar (orden de compensación).
    expect(ctx.participants.callsTo('releaseReservation')).toHaveLength(0);
    expect(saga.isTerminal).toBe(false);

    // Antes de la hora programada no se reintenta.
    expect((await ctx.recoverPendingSagas.execute()).recovered).toEqual([]);
    ctx.clock.advance(10_000);
    const report = await ctx.replica('replica-b').recoverPendingSagas.execute();

    expect(report.recovered).toEqual([
      { sagaId: SAGA_ID, from: 'COMPENSATION_FAILED', to: 'COMPENSATED' },
    ]);
    const refundKeys = ctx.participants.callsTo('refundDebit').map((c) => c.ctx.idempotencyKey);
    expect(new Set(refundKeys).size).toBe(1);
  });

  it('no recuperable: sin reintento automático; solo un reintento CONTROLADO la retoma', async () => {
    const participants = new FakeParticipants()
      .respond('debit', { kind: 'REJECTED', code: 'INSUFFICIENT_FUNDS' })
      .respond('releaseReservation', { kind: 'REJECTED', code: 'RESERVATION_MISMATCH' });
    const ctx = createContext({ participants });

    const { saga } = await ctx.reserveAndActivateCharging.execute(command());
    expect(saga.compensationFailure).toMatchObject({
      step: 'RELEASE_RESERVATION',
      errorCode: 'RESERVATION_MISMATCH',
    });
    expect(saga.compensationFailure?.nextAttemptAt).toBeUndefined();
    expect(ctx.participants.callsTo('releaseReservation')).toHaveLength(1);

    ctx.clock.advance(3_600_000);
    expect((await ctx.recoverPendingSagas.execute()).recovered).toEqual([]);

    const retried = await ctx.retryCompensation.execute(SAGA_ID);
    expect(retried.status).toBe('COMPENSATED');
  });

  it('no marca COMPENSATED con una respuesta que no verifica la compensación', async () => {
    const participants = new FakeParticipants()
      .respond('activateSession', { kind: 'REJECTED', code: 'CHARGER_HARDWARE_FAULT' })
      .respond('refundDebit', { kind: 'OK', value: { status: 'DEBITED', outcome: 'PENDING' } });
    const ctx = createContext({ participants });

    const { saga } = await ctx.reserveAndActivateCharging.execute(command());

    expect(saga.status).toBe('COMPENSATION_FAILED');
    expect(saga.compensationFailure?.errorCode).toBe('UNVERIFIED_COMPENSATION');
    expect(saga.steps.REFUND_DEBIT?.status).toBe('FAILED');
  });

  it('agotadas las rondas automáticas queda a la espera de un reintento controlado', async () => {
    const participants = new FakeParticipants()
      .respond('debit', { kind: 'REJECTED', code: 'INSUFFICIENT_FUNDS' })
      .failTransiently('releaseReservation', 9, 'HTTP_503');
    const ctx = createContext({ participants });
    await ctx.reserveAndActivateCharging.execute(command());

    for (let round = 0; round < 3; round++) {
      ctx.clock.advance(120_000);
      await ctx.recoverPendingSagas.execute();
    }
    const saga = ctx.sagas.rows.get(SAGA_ID)?.saga;
    expect(saga?.status).toBe('COMPENSATION_FAILED');
    expect(saga?.compensationFailure).toMatchObject({ round: 3 });
    expect(saga?.compensationFailure?.nextAttemptAt).toBeUndefined();
    expect(ctx.participants.callsTo('releaseReservation')).toHaveLength(9);

    expect((await ctx.retryCompensation.execute(SAGA_ID)).status).toBe('COMPENSATED');
  });

  it('solo se reintenta una SAGA en COMPENSATION_FAILED', async () => {
    const ctx = createContext();
    await ctx.reserveAndActivateCharging.execute(command());

    await expect(ctx.retryCompensation.execute(SAGA_ID)).rejects.toBeInstanceOf(
      SagaNotRetryableError,
    );
  });
});

describe('Concurrencia y reintentos', () => {
  it('si otra réplica toma la SAGA, este proceso deja de ejecutarla (lease + versión)', async () => {
    const participants = new FakeParticipants();
    const ctx = createContext({ participants });
    participants.onCall = (operation) => {
      if (operation === 'debit') {
        // Otra réplica roba el lease mientras esta espera al servicio.
        const row = ctx.sagas.rows.get(SAGA_ID);
        if (row !== undefined) {
          row.lease = { owner: 'replica-b', expiresAt: new Date(Date.now() + 60_000) };
        }
      }
    };

    const { saga } = await ctx.reserveAndActivateCharging.execute(command());

    // La escritura posterior al débito se rechazó: no se activó la carga.
    expect(saga.status).toBe('RESERVATION_COMPLETED');
    expect(ctx.participants.callsTo('activateSession')).toHaveLength(0);
  });

  it('reintento controlado con la SAGA en ejecución por otra réplica → SAGA_BUSY', async () => {
    const participants = new FakeParticipants()
      .respond('debit', { kind: 'REJECTED', code: 'INSUFFICIENT_FUNDS' })
      .respond('releaseReservation', { kind: 'REJECTED', code: 'RESERVATION_MISMATCH' });
    const ctx = createContext({ participants });
    await ctx.reserveAndActivateCharging.execute(command());
    await ctx.sagas.acquireLease(
      sagaId,
      { owner: 'replica-b', expiresAt: new Date(ctx.clock.now().getTime() + 30_000) },
      ctx.clock.now(),
    );

    await expect(ctx.retryCompensation.execute(SAGA_ID)).rejects.toBeInstanceOf(SagaBusyError);
  });

  it('errores transitorios se reintentan con backoff y luego se abandona el paso', async () => {
    const recovers = new FakeParticipants().failTransiently('holdReservation', 2, 'NETWORK_ERROR');
    const ok = createContext({ participants: recovers });
    expect((await ok.reserveAndActivateCharging.execute(command())).saga.status).toBe('COMPLETED');
    expect(ok.participants.callsTo('holdReservation')).toHaveLength(3);
    expect(ok.sleeps).toEqual([150, 300]);

    const exhausted = new FakeParticipants().failTransiently('debit', 3);
    const ko = createContext({ participants: exhausted });
    const { saga } = await ko.reserveAndActivateCharging.execute(command());
    expect(ko.participants.callsTo('debit')).toHaveLength(3);
    // Resultado desconocido del débito: se reembolsa (idempotente) y se libera.
    expect(saga).toMatchObject({
      status: 'COMPENSATED',
      failureReason: 'STEP_RETRIES_EXHAUSTED',
      compensationPlan: ['REFUND_DEBIT', 'RELEASE_RESERVATION'],
    });
  });

  it('reserva rechazada: FAILED sin compensaciones ni más llamadas', async () => {
    const participants = new FakeParticipants().respond('holdReservation', {
      kind: 'REJECTED',
      code: 'CONNECTOR_UNAVAILABLE',
    });
    const ctx = createContext({ participants });

    const { saga } = await ctx.reserveAndActivateCharging.execute(command());

    expect(saga).toMatchObject({ status: 'FAILED', failureReason: 'CONNECTOR_UNAVAILABLE' });
    expect(ctx.participants.operations).toEqual(['getConnectorPower', 'holdReservation']);
  });
});
