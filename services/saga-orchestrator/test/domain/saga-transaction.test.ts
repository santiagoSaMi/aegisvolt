import { describe, expect, it } from 'vitest';

import {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  InvalidSagaTransitionError,
  InvalidValueError,
  ReservationId,
  RetryPolicy,
  SagaId,
  SagaTransaction,
  SessionId,
  StationId,
  compensationPlanFor,
} from '../../src/domain/index.ts';

const NOW = new Date('2026-11-13T15:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const UUID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const random = (): number => 0.5;

function started(requestedEnergyKwh = 30): SagaTransaction {
  return SagaTransaction.start({
    id: SagaId.parse(`saga_${UUID}`),
    request: {
      fleetId: FleetId.parse('fleet_001'),
      stationId: StationId.parse('st_bog-norte-01'),
      connectorId: ConnectorId.parse('cn_01'),
      requestedEnergyKwh,
      fastChargeBoost: false,
    },
    resources: {
      reservationId: ReservationId.parse(`res_${UUID}`),
      debitId: DebitId.parse(`dbt_${UUID}`),
      sessionId: SessionId.parse(`ses_${UUID}`),
    },
    correlationId: CorrelationId.parse(UUID),
    now: NOW,
  });
}

/** SAGA en el paso indicado (cada paso anterior completado). */
function inStatus(status: 'RESERVING' | 'DEBITING' | 'ACTIVATING' | 'CONFIRMING'): SagaTransaction {
  const order = ['RESERVING', 'DEBITING', 'ACTIVATING', 'CONFIRMING'];
  let saga = started().beginReservation(at(1));
  for (let i = 0; i < order.indexOf(status); i++) {
    saga = saga.completeCurrentStep(at(10 + i));
  }
  return saga;
}

const eventTypes = (saga: SagaTransaction): string[] => saga.events.map((event) => event.type);

describe('SagaTransaction: creación', () => {
  it('nace STARTED con el evento SAGA_STARTED y los ids pre-generados', () => {
    const saga = started();
    expect(saga.status).toBe('STARTED');
    expect(saga.events).toEqual([{ sequence: 0, type: 'SAGA_STARTED', occurredAt: NOW }]);
    expect(saga.resources.debitId).toBe(`dbt_${UUID}`);
  });

  it('valida la energía solicitada', () => {
    expect(() => started(0)).toThrow(InvalidValueError);
    expect(() => started(501)).toThrow(InvalidValueError);
  });

  it('el correlation_id debe ser un UUID', () => {
    expect(() => CorrelationId.parse('c-123')).toThrow(InvalidValueError);
  });
});

describe('SAGA exitosa', () => {
  it('STARTED → RESERVING → DEBITING → ACTIVATING → CONFIRMING → COMPLETED', () => {
    const statuses: string[] = [];
    let saga = started().beginReservation(at(1));
    statuses.push(saga.status);
    while (!saga.isTerminal) {
      saga = saga.completeCurrentStep(at(statuses.length * 10));
      statuses.push(saga.status);
    }

    expect(statuses).toEqual(['RESERVING', 'DEBITING', 'ACTIVATING', 'CONFIRMING', 'COMPLETED']);
    expect(saga.steps.ACTIVATION).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(eventTypes(saga).at(-1)).toBe('SAGA_COMPLETED');
    expect(saga.events.map((event) => event.sequence)).toEqual(
      saga.events.map((_, index) => index),
    );
  });

  it('cada transición devuelve una instancia nueva (inmutable)', () => {
    const saga = started();
    const reserving = saga.beginReservation(at(1));
    expect(saga.status).toBe('STARTED');
    expect(reserving).not.toBe(saga);
  });
});

describe('Compensación por fondos insuficientes', () => {
  it('DEBITING → COMPENSATING (solo release) → COMPENSATED', () => {
    const compensating = inStatus('DEBITING').rejectCurrentStep('INSUFFICIENT_FUNDS', at(20));

    expect(compensating.status).toBe('COMPENSATING');
    expect(compensating.failureReason).toBe('INSUFFICIENT_FUNDS');
    expect(compensating.compensationPlan).toEqual(['RELEASE_RESERVATION']);
    expect(compensating.nextCompensation).toBe('RELEASE_RESERVATION');

    const done = compensating.compensationSucceeded('RELEASE_RESERVATION', at(30));
    expect(done.status).toBe('COMPENSATED');
    expect(eventTypes(done).slice(-4)).toEqual([
      'STEP_FAILED',
      'COMPENSATION_STARTED',
      'COMPENSATION_SUCCEEDED',
      'SAGA_COMPENSATED',
    ]);
  });
});

describe('Compensación por fallo de hardware', () => {
  it('ACTIVATING → abort → refund → release → COMPENSATED, en ese orden', () => {
    let saga = inStatus('ACTIVATING').rejectCurrentStep('CHARGER_HARDWARE_FAULT', at(30));
    expect(saga.compensationPlan).toEqual(['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION']);

    expect(() => saga.compensationSucceeded('REFUND_DEBIT', at(31))).toThrow(
      InvalidSagaTransitionError,
    );

    saga = saga.compensationSucceeded('ABORT_SESSION', at(31));
    saga = saga.compensationSucceeded('REFUND_DEBIT', at(32));
    expect(saga.status).toBe('COMPENSATING');
    saga = saga.compensationSucceeded('RELEASE_RESERVATION', at(33));

    expect(saga.status).toBe('COMPENSATED');
    expect(saga.failedStep).toBe('ACTIVATION');
  });

  it('una compensación ya registrada no se puede registrar de nuevo', () => {
    const saga = inStatus('ACTIVATING')
      .rejectCurrentStep('CHARGER_HARDWARE_FAULT', at(30))
      .compensationSucceeded('ABORT_SESSION', at(31));
    expect(() => saga.compensationSucceeded('ABORT_SESSION', at(32))).toThrow(
      InvalidSagaTransitionError,
    );
  });
});

describe('Rechazos de negocio', () => {
  it('rechazo en la reserva → FAILED sin compensaciones', () => {
    const saga = inStatus('RESERVING').rejectCurrentStep('CONNECTOR_UNAVAILABLE', at(5));
    expect(saga.status).toBe('FAILED');
    expect(saga.compensationPlan).toEqual([]);
    expect(eventTypes(saga).at(-1)).toBe('SAGA_FAILED');
  });

  it('el motivo debe corresponder al paso', () => {
    expect(() => inStatus('RESERVING').rejectCurrentStep('INSUFFICIENT_FUNDS', at(5))).toThrow(
      InvalidSagaTransitionError,
    );
    expect(() => inStatus('CONFIRMING').rejectCurrentStep('CHARGER_HARDWARE_FAULT', at(5))).toThrow(
      InvalidSagaTransitionError,
    );
  });
});

describe('Errores transitorios y abandono', () => {
  it('recordAttemptFailure cuenta intentos sin cambiar de estado', () => {
    const saga = inStatus('DEBITING')
      .recordAttemptFailure('TIMEOUT', at(20))
      .recordAttemptFailure('SERVER_ERROR', at(21));
    expect(saga.status).toBe('DEBITING');
    expect(saga.steps.DEBIT).toMatchObject({
      status: 'PENDING',
      attempts: 2,
      lastErrorCode: 'SERVER_ERROR',
    });

    const completed = saga.completeCurrentStep(at(22));
    expect(completed.steps.DEBIT).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
  });

  it('abandonar la reserva compensa con release preventivo y termina FAILED', () => {
    const saga = inStatus('RESERVING').abandonCurrentStep('STEP_RETRIES_EXHAUSTED', at(5));
    expect(saga.compensationPlan).toEqual(['RELEASE_RESERVATION']);
    expect(saga.compensationSucceeded('RELEASE_RESERVATION', at(6)).status).toBe('FAILED');
  });

  it('abandonar el débito también reembolsa (resultado desconocido)', () => {
    const saga = inStatus('DEBITING').abandonCurrentStep('RECOVERY_DEADLINE_EXCEEDED', at(5));
    expect(saga.compensationPlan).toEqual(['REFUND_DEBIT', 'RELEASE_RESERVATION']);
  });

  it('tras el pivote no se compensa: abandonar CONFIRMING requiere atención', () => {
    const saga = inStatus('CONFIRMING').abandonCurrentStep('STEP_RETRIES_EXHAUSTED', at(5));
    expect(saga.status).toBe('REQUIRES_ATTENTION');
  });

  it('abandonar antes de empezar → FAILED', () => {
    expect(started().abandonCurrentStep('RECOVERY_DEADLINE_EXCEEDED', at(5)).status).toBe('FAILED');
  });

  it('no se avanza una SAGA terminal', () => {
    const failed = inStatus('RESERVING').rejectCurrentStep('CONNECTOR_UNAVAILABLE', at(5));
    expect(() => failed.completeCurrentStep(at(6))).toThrow(InvalidSagaTransitionError);
    expect(() => failed.markRecovered(at(6))).toThrow(InvalidSagaTransitionError);
  });
});

describe('Reintentos de compensación', () => {
  const policy = new RetryPolicy({
    maxAttempts: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
    multiplier: 2,
  });

  it('un fallo programa el reintento (COMPENSATION_PENDING) y se reanuda a su hora', () => {
    const compensating = inStatus('DEBITING').rejectCurrentStep('INSUFFICIENT_FUNDS', at(20));
    const pending = compensating.compensationFailed(
      'RELEASE_RESERVATION',
      'TIMEOUT',
      at(30),
      policy,
      random,
    );

    expect(pending.status).toBe('COMPENSATION_PENDING');
    expect(pending.nextAttemptAt).toEqual(at(30 + 750)); // 1000 × (0,5 + 0,5 × 0,5)
    expect(() => pending.resumeCompensation(at(100))).toThrow(InvalidSagaTransitionError);

    const resumed = pending.resumeCompensation(at(780));
    expect(resumed.status).toBe('COMPENSATING');
    expect(resumed.nextAttemptAt).toBeUndefined();
    expect(resumed.compensationSucceeded('RELEASE_RESERVATION', at(800)).status).toBe(
      'COMPENSATED',
    );
  });

  it('agotadas las rondas → REQUIRES_ATTENTION', () => {
    const saga = inStatus('DEBITING')
      .rejectCurrentStep('INSUFFICIENT_FUNDS', at(20))
      .compensationFailed('RELEASE_RESERVATION', 'TIMEOUT', at(30), policy, random)
      .resumeCompensation(at(10_000))
      .compensationFailed('RELEASE_RESERVATION', 'TIMEOUT', at(10_001), policy, random);

    expect(saga.status).toBe('REQUIRES_ATTENTION');
    expect(saga.nextAttemptAt).toBeUndefined();
    expect(saga.steps.RELEASE_RESERVATION?.attempts).toBe(2);
  });
});

describe('Recuperación tras reinicio', () => {
  it('detecta SAGAs sin actividad reciente y reintentos vencidos', () => {
    const saga = inStatus('DEBITING');
    expect(saga.isDueForRecovery(at(5_000), 15_000)).toBe(false);
    expect(saga.isDueForRecovery(at(20_000), 15_000)).toBe(true);

    const policy = RetryPolicy.COMPENSATION;
    const pending = saga
      .rejectCurrentStep('INSUFFICIENT_FUNDS', at(20))
      .compensationFailed('RELEASE_RESERVATION', 'TIMEOUT', at(30), policy, random);
    expect(pending.isDueForRecovery(at(31), 15_000)).toBe(false);
    expect(pending.isDueForRecovery(pending.nextAttemptAt!, 15_000)).toBe(true);
  });

  it('pasado el plazo de avance se compensa, salvo tras el pivote', () => {
    expect(inStatus('ACTIVATING').exceedsForwardDeadline(at(61_000), 60_000)).toBe(true);
    expect(inStatus('ACTIVATING').exceedsForwardDeadline(at(59_000), 60_000)).toBe(false);
    expect(inStatus('CONFIRMING').exceedsForwardDeadline(at(61_000), 60_000)).toBe(false);
  });

  it('markRecovered añade el evento RECOVERED sin cambiar el estado', () => {
    const saga = inStatus('DEBITING').markRecovered(at(30_000));
    expect(saga.status).toBe('DEBITING');
    expect(eventTypes(saga).at(-1)).toBe('RECOVERED');
  });

  it('restore valida las invariantes', () => {
    const base = inStatus('DEBITING');
    const props = {
      id: base.id,
      request: base.request,
      resources: base.resources,
      correlationId: base.correlationId,
      steps: base.steps,
      events: base.events,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
    };
    expect(() =>
      SagaTransaction.restore({ ...props, status: 'COMPENSATING', compensationPlan: [] }),
    ).toThrow(InvalidValueError);
    expect(() =>
      SagaTransaction.restore({
        ...props,
        status: 'COMPLETED',
        compensationPlan: [],
        nextAttemptAt: NOW,
      }),
    ).toThrow(InvalidValueError);
    expect(
      SagaTransaction.restore({ ...props, status: 'DEBITING', compensationPlan: [] }).status,
    ).toBe('DEBITING');
  });
});

describe('compensationPlanFor', () => {
  it.each([
    ['RESERVATION', true, []],
    ['RESERVATION', false, ['RELEASE_RESERVATION']],
    ['DEBIT', true, ['RELEASE_RESERVATION']],
    ['DEBIT', false, ['REFUND_DEBIT', 'RELEASE_RESERVATION']],
    ['ACTIVATION', true, ['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION']],
  ] as const)('%s (resultado conocido: %s) → %j', (step, known, plan) => {
    expect(compensationPlanFor(step, known)).toEqual(plan);
  });
});
