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

/** Lectura coherente: 400 V × 145 A = 58 kW. */
function reading(offsetMs: number, energyKwh: number): TelemetryReading {
  return {
    timestamp: at(offsetMs),
    voltageV: 400,
    currentA: 145,
    powerKw: 58,
    energyKwh,
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
  it('activación correcta → ACTIVE con su primera transición', () => {
    const result = start();
    expect(result.kind).toBe('STARTED');
    expect(result.session.status).toBe('ACTIVE');
    expect(result.session.endedAt).toBeUndefined();
    expect(result.session.transitions).toEqual([{ from: undefined, to: 'ACTIVE', at: NOW }]);
  });

  it('falla del cargador (p. ej. flag de simulación) → FAILED con la falla', () => {
    const session = start({
      activation: { kind: 'FAULT', fault: ChargerFault.simulatedHardwareFault() },
    }).session;

    expect(session.status).toBe('FAILED');
    expect(session.fault?.simulated).toBe(true);
    expect(session.endedAt).toEqual(NOW);
    expect(session.transitions[0]).toMatchObject({ to: 'FAILED', reason: 'E-HW-001' });
  });

  it('repetir con los mismos términos no vuelve a activar el cargador (REPLAYED)', () => {
    const existing = active();
    expect(
      start({ existing, activation: { kind: 'FAULT', fault: ChargerFault.of('E-HW-002', false) } }),
    ).toEqual({ kind: 'REPLAYED', session: existing });
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
  it('stop: ACTIVE → COMPLETED con motivo; repetirlo es idempotente', () => {
    const first = active().stop('USER_REQUEST', at(60_000));
    expect(first.outcome).toBe('STOPPED');
    expect(first.session).toMatchObject({
      status: 'COMPLETED',
      stopReason: 'USER_REQUEST',
      endedAt: at(60_000),
    });
    expect(first.session.transitions.map((t) => [t.from, t.to, t.reason])).toEqual([
      [undefined, 'ACTIVE', undefined],
      ['ACTIVE', 'COMPLETED', 'USER_REQUEST'],
    ]);

    const again = first.session.stop('OPERATOR_REQUEST', at(70_000));
    expect(again).toEqual({ session: first.session, outcome: 'ALREADY_STOPPED' });
  });

  it('stop exige una sesión ACTIVE (FAILED o ABORTED no se paran)', () => {
    const aborted = active().abort(at(1_000)).session;
    expect(() => aborted.stop('USER_REQUEST', at(2_000))).toThrow(SessionNotActiveError);
    const failed = start({
      activation: { kind: 'FAULT', fault: ChargerFault.of('E-HW-001', false) },
    }).session;
    expect(() => failed.stop('USER_REQUEST', at(2_000))).toThrow(SessionNotActiveError);
  });

  it('abort es idempotente y distingue el estado previo', () => {
    const first = active().abort(at(1_000));
    expect(first.outcome).toBe('ABORTED');
    expect(first.session.status).toBe('ABORTED');
    expect(first.session.transitions.at(-1)).toMatchObject({ from: 'ACTIVE', to: 'ABORTED' });
    expect(first.session.abort(at(2_000)).outcome).toBe('ALREADY_ABORTED');

    const failed = start({
      activation: { kind: 'FAULT', fault: ChargerFault.of('E-HW-001', false) },
    }).session;
    expect(failed.abort(at(1_000))).toEqual({ session: failed, outcome: 'ALREADY_FAILED' });
  });

  it('no se puede abortar una carga completada (ya no es compensable)', () => {
    const completed = active().stop('TARGET_REACHED', at(60_000)).session;
    expect(() => completed.abort(at(70_000))).toThrow(SessionAlreadyCompletedError);
  });

  it('abortSession sin sesión deja un tombstone (VOIDED)', () => {
    expect(abortSession({ sessionId: SESSION_ID, session: undefined, now: NOW }).outcome).toBe(
      'VOIDED',
    );
  });

  it('restore valida las invariantes de fault, endedAt, stopReason y transiciones', () => {
    const base = {
      id: SESSION_ID,
      terms: terms(),
      startedAt: NOW,
      updatedAt: NOW,
      transitions: [{ from: undefined, to: 'ACTIVE' as const, at: NOW }],
    };
    expect(() => ChargingSession.restore({ ...base, status: 'FAILED', endedAt: NOW })).toThrow(
      InvalidValueError,
    );
    expect(() =>
      ChargingSession.restore({
        ...base,
        status: 'COMPLETED',
        endedAt: NOW,
        transitions: [...base.transitions, { from: 'ACTIVE', to: 'COMPLETED', at: NOW }],
      }),
    ).toThrow(/stopReason/);
    expect(() => ChargingSession.restore({ ...base, status: 'ABORTED', endedAt: NOW })).toThrow(
      /transitions/,
    );
    expect(ChargingSession.restore({ ...base, status: 'ACTIVE' }).status).toBe('ACTIVE');
  });
});

describe('Telemetría', () => {
  it('registra lecturas ordenadas y actualiza la última lectura de la sesión', () => {
    const first = active().recordTelemetry(reading(10_000, 1.2));
    const second = first.session.recordTelemetry(reading(20_000, 2.4));

    expect(second.record).toBeInstanceOf(TelemetryRecord);
    expect(second.record).toMatchObject({ sessionId: SESSION_ID, energyKwh: 2.4, currentA: 145 });
    expect(second.session.lastTelemetry).toEqual({ timestamp: at(20_000), energyKwh: 2.4 });
  });

  it('rechaza lecturas fuera de orden o con energía decreciente', () => {
    const { session } = active().recordTelemetry(reading(10_000, 2));

    expect(() => session.recordTelemetry(reading(10_000, 3))).toThrow(TelemetryOutOfOrderError);
    expect(() => session.recordTelemetry(reading(5_000, 3))).toThrow(TelemetryOutOfOrderError);
    expect(() => session.recordTelemetry(reading(20_000, 1))).toThrow(TelemetryOutOfOrderError);
  });

  it('rechaza lecturas físicamente imposibles o incoherentes', () => {
    const session = active();
    expect(() => session.recordTelemetry({ ...reading(1_000, 1), temperatureC: 500 })).toThrow(
      InvalidValueError,
    );
    expect(() => session.recordTelemetry({ ...reading(1_000, 1), voltageV: -1 })).toThrow(
      /voltageV/,
    );
    expect(() => session.recordTelemetry({ ...reading(1_000, 1), currentA: Number.NaN })).toThrow(
      /currentA/,
    );
    // 400 V × 145 A = 58 kW: declarar 120 kW es incoherente.
    expect(() => session.recordTelemetry({ ...reading(1_000, 1), powerKw: 120 })).toThrow(
      /powerKw/,
    );
    expect(() => session.recordTelemetry(reading(1_000, 30.001))).toThrow(/energyKwh/);
    expect(() => session.recordTelemetry(reading(-1_000, 1))).toThrow(/timestamp/);
  });

  it('acepta la tolerancia de medición en la coherencia P ≈ V × I', () => {
    expect(() => active().recordTelemetry({ ...reading(1_000, 1), powerKw: 55 })).not.toThrow();
  });

  it('una sesión terminada no acepta telemetría', () => {
    const aborted = active().abort(at(1_000)).session;
    expect(() => aborted.recordTelemetry(reading(2_000, 1))).toThrow(SessionNotActiveError);
  });

  it('sameReadingAs detecta la misma lectura (reintento idempotente)', () => {
    const a = TelemetryRecord.create(SESSION_ID, reading(1_000, 1));
    expect(a.sameReadingAs(TelemetryRecord.create(SESSION_ID, reading(1_000, 1)))).toBe(true);
    expect(a.sameReadingAs(TelemetryRecord.create(SESSION_ID, reading(1_000, 1.1)))).toBe(false);
  });
});
