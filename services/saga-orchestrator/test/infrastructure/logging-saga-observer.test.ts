import { createLogger } from '@aegisvolt/logger';
import { describe, expect, it } from 'vitest';

import {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  ReservationId,
  SagaId,
  SagaTransaction,
  SessionId,
  StationId,
} from '../../src/domain/index.ts';
import { LoggingSagaObserver } from '../../src/infrastructure/observability/logging-saga-observer.ts';

const NOW = new Date('2026-11-13T15:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const UUID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const CORRELATION = '6c1f0b8e-2d3a-4b5c-9d7e-0123456789ab';

function started(): SagaTransaction {
  return SagaTransaction.start({
    id: SagaId.parse(`saga_${UUID}`),
    idempotencyKey: UUID,
    request: {
      fleetId: FleetId.parse('fleet_001'),
      stationId: StationId.parse('st_bog-norte-01'),
      connectorId: ConnectorId.parse('cn_01'),
      requestedEnergyKwh: 30,
      fastChargeBoost: false,
    },
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
    correlationId: CorrelationId.parse(CORRELATION),
    now: NOW,
  });
}

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'saga-orchestrator-service',
    environment: 'test',
    version: 'test',
    destination: {
      write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  return { observer: new LoggingSagaObserver(logger), lines };
}

describe('LoggingSagaObserver (ADR-0028)', () => {
  it('registra cada evento con el correlation_id de la SAGA, saga_id y la operación', () => {
    const { observer, lines } = capture();
    let saga = started();
    for (let i = 0; i < 4; i++) {
      saga = saga
        .beginStep(at(i * 10 + 1))
        .completeStep(at(i * 10 + 2), i === 0 ? { connectorPowerKw: 60 } : {});
    }

    observer.transitioned(saga, saga.pendingEvents);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toMatchObject({
        correlation_id: CORRELATION,
        saga_id: `saga_${UUID}`,
        operation: 'ReserveAndActivateCharging',
        component: 'saga',
      });
    }
    // Solo el evento terminal lleva la duración (para la métrica SagaDuration).
    const completed = lines.filter((line) => line.event === 'SAGA_COMPLETED');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      duration_ms: 32,
      saga_status: 'COMPLETED',
      level: 'info',
    });
    expect(lines.filter((line) => line.duration_ms !== undefined)).toHaveLength(1);
  });

  it('un paso rechazado lleva un error tipado con el código del servicio', () => {
    const { observer, lines } = capture();
    const saga = started()
      .beginStep(at(1))
      .rejectStep('CONNECTOR_UNAVAILABLE', 'CONNECTOR_UNAVAILABLE', at(250));

    observer.transitioned(saga, saga.pendingEvents);

    const failed = lines.find((line) => line.event === 'STEP_FAILED');
    expect(failed).toMatchObject({ level: 'warn', step: 'RESERVATION' });
    expect(failed?.error).toEqual({
      type: 'SagaStepFailure',
      code: 'CONNECTOR_UNAVAILABLE',
      message: 'Paso RESERVATION fallido',
    });
    const terminal = lines.find((line) => line.event === 'SAGA_FAILED');
    expect(terminal).toMatchObject({ duration_ms: 250, saga_status: 'FAILED' });
  });
});
