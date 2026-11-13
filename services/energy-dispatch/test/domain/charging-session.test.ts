import { describe, expect, it } from 'vitest';

import {
  ChargerFault,
  ChargingSession,
  ConnectorId,
  InvalidValueError,
  RequestedEnergy,
  SagaId,
  SessionAbortedError,
  SessionAlreadyCompletedError,
  SessionId,
  SessionNotActiveError,
  SessionTermsMismatchError,
  SessionTombstone,
  StationId,
  TelemetryOutOfOrderError,
  TelemetryRecord,
  abortSession,
  startSession,
  type SessionTerms,
  type TelemetryReading,
} from '../../src/domain/index.ts';

const NOW = new Date('2026-11-13T15:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const SESSION_ID = SessionId.parse('ses_3f2c1e5a-1b2c-4d3e-8f90-123456789abc');

function terms(kwh = 30): SessionTerms {
  return {
    sagaId: SagaId.parse('saga_3f2c1e5a-1b2c-4d3e-8f90-123456789abc'),
    stationId: StationId.parse('st_bog-norte-01'),
    connectorId: ConnectorId.parse('cn_01'),
    requestedEnergy: RequestedEnergy.fromKwh(kwh),
  };
}

function start(overrides: Partial<Parameters<typeof startSession>[0]> = {}) {
  return startSession({
    sessionId: SESSION_ID,
    terms: terms(),
    existing: undefined,
    tombstone: undefined,
    activation: { kind: 'ACTIVATED' },
    now: NOW,
    ...overrides,
  });
}

const active = (): ChargingSession => start().session;

function reading(offsetMs: number, energyKwh: number): TelemetryReading {
  return {
    recordedAt: at(offsetMs),
    powerKw: 58.5,
    energyDeliveredKwh: energyKwh,
    voltageV: 400,
    temperatureC: 35,
  };
}

describe('Value Objects', () => {
  it('ChargerFault valida el formato del código', () => {
    expect(ChargerFault.of('E-HW-001', false).code).toBe('E-HW-001');
    expect(ChargerFault.simulatedHardwareFault()).toMatchObject({
      code: 'E-HW-001',
      simulated: true,
    });
    expect(() => ChargerFault.of('HW-1', false)).toThrow(InvalidValueError);
  });

  it('RequestedEnergy usa Wh enteros', () => {
    expect(RequestedEnergy.fromKwh(12.345).wattHours).toBe(12_345);
    expect(() => RequestedEnergy.fromKwh(0)).toThrow(InvalidValueError);
    expect(() => RequestedEnergy.fromKwh(600)).toThrow(InvalidValueError);
  });
});

describe('startSession (paso 3 de la SAGA)', () => {
  it('activación correcta → ACTIVE', () => {
    const result = start();
    expect(result.kind).toBe('STARTED');
    expect(result.session.status).toBe('ACTIVE');
    expect(result.session.endedAt).toBeUndefined();
  });

  it('falla del cargador (p. ej. flag de simulación) → FAILED con la falla', () => {
    const session = start({
      activation: { kind: 'FAULT', fault: ChargerFault.simulatedHardwareFault() },
    }).session;

    expect(session.status).toBe('FAILED');
    expect(session.fault?.simulated).toBe(true);
    expect(session.endedAt).toEqual(NOW);
  });

  it('repetir con los mismos términos no vuelve a activar el cargador (REPLAYED)', () => {
    const existing = active();
    expect(
      start({ existing, activation: { kind: 'FAULT', fault: ChargerFault.of('E-HW-002', false) } }),
    ).toEqual({
      kind: 'REPLAYED',
      session: existing,
    });
  });

  it('mismo id con otros términos → conflicto; tombstone → SESSION_ABORTED', () => {
    expect(() => start({ existing: active(), terms: terms(31) })).toThrow(
      SessionTermsMismatchError,
    );
    expect(() => start({ tombstone: SessionTombstone.create(SESSION_ID, NOW) })).toThrow(
      SessionAbortedError,
    );
  });
});

describe('ChargingSession: transiciones', () => {
  it('abort es idempotente y distingue el estado previo', () => {
    const first = active().abort(at(1_000));
    expect(first.outcome).toBe('ABORTED');
    expect(first.session.status).toBe('ABORTED');
    expect(first.session.abort(at(2_000)).outcome).toBe('ALREADY_ABORTED');

    const failed = start({
      activation: { kind: 'FAULT', fault: ChargerFault.of('E-HW-001', false) },
    }).session;
    expect(failed.abort(at(1_000))).toEqual({ session: failed, outcome: 'ALREADY_FAILED' });
  });

  it('no se puede abortar una carga completada (ya no es compensable)', () => {
    const completed = active().complete(at(60_000));
    expect(completed.status).toBe('COMPLETED');
    expect(completed.complete(at(70_000))).toBe(completed);
    expect(() => completed.abort(at(70_000))).toThrow(SessionAlreadyCompletedError);
  });

  it('solo se completa una sesión ACTIVE', () => {
    const aborted = active().abort(at(1_000)).session;
    expect(() => aborted.complete(at(2_000))).toThrow(SessionNotActiveError);
  });

  it('abortSession sin sesión deja un tombstone (VOIDED)', () => {
    expect(abortSession({ sessionId: SESSION_ID, session: undefined, now: NOW }).outcome).toBe(
      'VOIDED',
    );
  });

  it('restore valida las invariantes de fault y endedAt', () => {
    const base = { id: SESSION_ID, terms: terms(), startedAt: NOW, updatedAt: NOW };
    expect(() => ChargingSession.restore({ ...base, status: 'FAILED', endedAt: NOW })).toThrow(
      InvalidValueError,
    );
    expect(() => ChargingSession.restore({ ...base, status: 'COMPLETED' })).toThrow(
      InvalidValueError,
    );
    expect(ChargingSession.restore({ ...base, status: 'ACTIVE' }).status).toBe('ACTIVE');
  });
});

describe('Telemetría', () => {
  it('registra lecturas ordenadas de una sesión activa', () => {
    const session = active();
    const first = session.recordTelemetry(reading(10_000, 1.2), undefined);
    const second = session.recordTelemetry(reading(20_000, 2.4), first);

    expect(second).toBeInstanceOf(TelemetryRecord);
    expect(second.energyDeliveredKwh).toBe(2.4);
  });

  it('rechaza lecturas fuera de orden o con energía decreciente', () => {
    const session = active();
    const first = session.recordTelemetry(reading(10_000, 2), undefined);

    expect(() => session.recordTelemetry(reading(10_000, 3), first)).toThrow(
      TelemetryOutOfOrderError,
    );
    expect(() => session.recordTelemetry(reading(20_000, 1), first)).toThrow(
      TelemetryOutOfOrderError,
    );
  });

  it('rechaza lecturas físicamente imposibles o mayores que la energía solicitada', () => {
    const session = active();
    expect(() =>
      session.recordTelemetry({ ...reading(1_000, 1), temperatureC: 500 }, undefined),
    ).toThrow(InvalidValueError);
    expect(() => session.recordTelemetry(reading(1_000, 30.001), undefined)).toThrow(
      InvalidValueError,
    );
    expect(() => session.recordTelemetry(reading(-1_000, 1), undefined)).toThrow(InvalidValueError);
  });

  it('una sesión terminada no acepta telemetría', () => {
    const aborted = active().abort(at(1_000)).session;
    expect(() => aborted.recordTelemetry(reading(2_000, 1), undefined)).toThrow(
      SessionNotActiveError,
    );
  });
});
