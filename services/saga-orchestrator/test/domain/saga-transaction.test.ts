import { describe, expect, it } from 'vitest';

import {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  IdempotencyKeyConflictError,
  InvalidSagaTransitionError,
  InvalidValueError,
  ReservationId,
  RetryPolicy,
  SagaId,
  SagaNotRetryableError,
  SagaTransaction,
  SessionId,
  StationId,
  compensationPlanFor,
} from '../../src/domain/index.ts';

const NOW = new Date('2026-11-13T15:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const UUID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const random = (): number => 0.5;
const ROUNDS = new RetryPolicy({
  maxAttempts: 2,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  multiplier: 3,
});

const request = (requestedEnergyKwh = 30) => ({
  fleetId: FleetId.parse('fleet_001'),
  stationId: StationId.parse('st_bog-norte-01'),
  connectorId: ConnectorId.parse('cn_01'),
  requestedEnergyKwh,
  fastChargeBoost: false,
});

function started(requestedEnergyKwh = 30): SagaTransaction {
  return SagaTransaction.start({
    id: SagaId.parse(`saga_${UUID}`),
    idempotencyKey: UUID,
    request: request(requestedEnergyKwh),
    resources: {
      reservationId: ReservationId.parse(`res_${UUID}`),
      debitId: DebitId.parse(`dbt_${UUID}`),
      sessionId: SessionId.parse(`ses_${UUID}`),
    },
    operationKeys: {
      CONFIRMATION: 'k-confirm',
      ABORT_SESSION: 'k-abort',
      REFUND_DEBIT: 'k-refund',
      RELEASE_RESERVATION: 'k-release',
    },
    correlationId: CorrelationId.parse(UUID),
    now: NOW,
  });
}

/** Ejecuta `n` pasos de avance con éxito. */
function advanced(steps: number): SagaTransaction {
  let saga = started();
  for (let i = 0; i < steps; i++) {
    saga = saga.beginStep(at(i * 10 + 1));
    saga = saga.completeStep(at(i * 10 + 2), i === 0 ? { connectorPowerKw: 60 } : {});
  }
  return saga;
}

describe('creación', () => {
  it('nace STARTED con SAGA_STARTED pendiente de persistir y claves estables', () => {
    const saga = started();
    expect(saga.status).toBe('STARTED');
    expect(saga.pendingEvents).toEqual([
      { sequence: 0, type: 'SAGA_STARTED', status: 'STARTED', occurredAt: NOW },
    ]);
    expect(saga.idempotencyKeyFor('DEBIT')).toBe(`dbt_${UUID}`);
    expect(saga.idempotencyKeyFor('REFUND_DEBIT')).toBe('k-refund');
  });

  it('valida energía, correlation_id y claves de operación', () => {
    expect(() => started(0)).toThrow(InvalidValueError);
    expect(() => started(501)).toThrow(InvalidValueError);
    expect(() => CorrelationId.parse('c-123')).toThrow(InvalidValueError);
  });

  it('la misma clave exige la misma petición', () => {
    expect(() => {
      started().assertSameRequest(request());
    }).not.toThrow();
    expect(() => {
      started().assertSameRequest(request(31));
    }).toThrow(IdempotencyKeyConflictError);
  });
});

describe('avance', () => {
  it('STARTED → RESERVATION_COMPLETED → BILLING_COMPLETED → DISPATCH_COMPLETED → COMPLETED', () => {
    const statuses = [0, 1, 2, 3, 4].map((n) => advanced(n).status);
    expect(statuses).toEqual([
      'STARTED',
      'RESERVATION_COMPLETED',
      'BILLING_COMPLETED',
      'DISPATCH_COMPLETED',
      'COMPLETED',
    ]);
    expect(advanced(4).isTerminal).toBe(true);
    expect(advanced(1).connectorPowerKw).toBe(60);
  });

  it('beginStep marca el paso IN_PROGRESS (intención) y cuenta el intento', () => {
    const saga = started().beginStep(at(1));
    expect(saga.steps.RESERVATION).toMatchObject({ status: 'IN_PROGRESS', attempts: 1 });
    expect(saga.pendingEvents.at(-1)).toMatchObject({ type: 'STEP_STARTED', attempt: 1 });
  });

  it('no se completa un paso no intentado ni la reserva sin potencia', () => {
    expect(() => started().completeStep(at(1))).toThrow(InvalidSagaTransitionError);
    expect(() => started().beginStep(at(1)).completeStep(at(2))).toThrow(/connectorPowerKw/);
  });

  it('un fallo transitorio deja el paso PENDING con el error', () => {
    const saga = started().beginStep(at(1)).recordStepAttemptFailure('TIMEOUT', at(2));
    expect(saga.steps.RESERVATION).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastErrorCode: 'TIMEOUT',
    });
  });
});

describe('fallos y plan de compensación', () => {
  it('plan según el paso y si el resultado es conocido', () => {
    expect(compensationPlanFor('RESERVATION', true)).toEqual([]);
    expect(compensationPlanFor('RESERVATION', false)).toEqual(['RELEASE_RESERVATION']);
    expect(compensationPlanFor('DEBIT', true)).toEqual(['RELEASE_RESERVATION']);
    expect(compensationPlanFor('ACTIVATION', true)).toEqual([
      'REFUND_DEBIT',
      'RELEASE_RESERVATION',
    ]);
    expect(compensationPlanFor('ACTIVATION', false)).toEqual([
      'ABORT_SESSION',
      'REFUND_DEBIT',
      'RELEASE_RESERVATION',
    ]);
  });

  it('reserva rechazada → FAILED sin compensaciones', () => {
    const saga = started()
      .beginStep(at(1))
      .rejectStep('CONNECTOR_UNAVAILABLE', 'CONNECTOR_UNAVAILABLE', at(2));
    expect(saga).toMatchObject({ status: 'FAILED', failureReason: 'CONNECTOR_UNAVAILABLE' });
  });

  it('un rechazo debe pertenecer al paso (o ser STEP_REJECTED)', () => {
    const saga = advanced(1).beginStep(at(30));
    expect(() => saga.rejectStep('CHARGER_HARDWARE_FAULT', 'X', at(31))).toThrow(
      InvalidSagaTransitionError,
    );
    expect(saga.rejectStep('STEP_REJECTED', 'IDEMPOTENCY_CONFLICT', at(31)).status).toBe(
      'COMPENSATING',
    );
  });

  it('fondos insuficientes → COMPENSATING con el plan y compensaciones PENDING', () => {
    const saga = advanced(1)
      .beginStep(at(30))
      .rejectStep('INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS', at(31));
    expect(saga).toMatchObject({
      status: 'COMPENSATING',
      failedStep: 'DEBIT',
      compensationPlan: ['RELEASE_RESERVATION'],
    });
    expect(saga.steps.RELEASE_RESERVATION?.status).toBe('PENDING');
    expect(saga.nextCompensation).toBe('RELEASE_RESERVATION');
  });
});

describe('compensación', () => {
  const compensating = () =>
    advanced(2)
      .beginStep(at(40))
      .rejectStep('CHARGER_HARDWARE_FAULT', 'CHARGER_HARDWARE_FAULT', at(41));

  it('solo queda COMPENSATED cuando TODAS las compensaciones están verificadas', () => {
    let saga = compensating().beginCompensation(at(50));
    saga = saga.compensationSucceeded('REFUND_DEBIT', at(51));
    expect(saga.status).toBe('COMPENSATING');
    saga = saga.beginCompensation(at(52)).compensationSucceeded('RELEASE_RESERVATION', at(53));
    expect(saga.status).toBe('COMPENSATED');
  });

  it('respeta el orden del plan', () => {
    const saga = compensating().beginCompensation(at(50));
    expect(() => saga.compensationSucceeded('RELEASE_RESERVATION', at(51))).toThrow(
      InvalidSagaTransitionError,
    );
  });

  it('compensación fallida → COMPENSATION_FAILED con paso, error y reintento si es recuperable', () => {
    const saga = compensating()
      .beginCompensation(at(50))
      .compensationFailed(
        'REFUND_DEBIT',
        { errorCode: 'HTTP_503', retryable: true },
        at(51),
        ROUNDS,
        random,
      );
    expect(saga.status).toBe('COMPENSATION_FAILED');
    expect(saga.compensationFailure).toMatchObject({
      step: 'REFUND_DEBIT',
      errorCode: 'HTTP_503',
      round: 1,
    });
    expect(saga.compensationFailure?.nextAttemptAt).toEqual(at(51 + 3_750));
    expect(saga.isTerminal).toBe(false);
    expect(saga.isDueForRecovery(at(1_000), 15_000)).toBe(false);
    expect(saga.isDueForRecovery(at(51 + 3_750), 15_000)).toBe(true);
  });

  it('un error no recuperable no programa reintento automático', () => {
    const saga = compensating()
      .beginCompensation(at(50))
      .compensationFailed(
        'REFUND_DEBIT',
        { errorCode: 'DEBIT_MISMATCH', retryable: false },
        at(51),
        ROUNDS,
        random,
      );
    expect(saga.compensationFailure?.nextAttemptAt).toBeUndefined();
    expect(() => saga.retryCompensation(at(10_000_000), 'AUTOMATIC')).toThrow(
      SagaNotRetryableError,
    );
    const resumed = saga.retryCompensation(at(60), 'MANUAL');
    expect(resumed.status).toBe('COMPENSATING');
    expect(resumed.compensationFailure).toBeUndefined();
    expect(resumed.nextCompensation).toBe('REFUND_DEBIT');
  });

  it('solo se reintenta una SAGA en COMPENSATION_FAILED', () => {
    expect(() => advanced(4).retryCompensation(at(1), 'MANUAL')).toThrow(SagaNotRetryableError);
  });
});

describe('recuperación', () => {
  it('una SAGA inactiva se retoma; las terminales no', () => {
    expect(advanced(2).isDueForRecovery(at(10_000), 15_000)).toBe(false);
    expect(advanced(2).isDueForRecovery(at(16_000), 15_000)).toBe(true);
    expect(advanced(4).isDueForRecovery(at(1_000_000), 15_000)).toBe(false);
    expect(advanced(2).markRecovered(at(20_000)).pendingEvents.at(-1)?.type).toBe('RECOVERED');
  });

  it('el plazo de avance solo aplica antes del pivote', () => {
    expect(advanced(2).exceedsForwardDeadline(at(61_000), 60_000)).toBe(true);
    expect(advanced(3).exceedsForwardDeadline(at(61_000), 60_000)).toBe(false);
  });

  it('restore valida las invariantes', () => {
    const saga = advanced(1);
    expect(() =>
      SagaTransaction.restore({
        id: saga.id,
        idempotencyKey: saga.idempotencyKey,
        request: saga.request,
        resources: saga.resources,
        operationKeys: saga.operationKeys,
        correlationId: saga.correlationId,
        status: 'COMPENSATION_FAILED',
        steps: saga.steps,
        compensationPlan: ['RELEASE_RESERVATION'],
        compensationRounds: 1,
        eventCount: 3,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow(/compensationFailure/);
  });
});
