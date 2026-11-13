import { describe, expect, it } from 'vitest';

import {
  ChargerUnavailableError,
  ConcurrentModificationError,
  SessionNotFoundError,
} from '../../src/application/index.ts';
import {
  ChargerFault,
  ConnectorBusyError,
  InvalidValueError,
  SessionAbortedError,
  SessionAlreadyCompletedError,
  SessionNotActiveError,
  SessionTermsMismatchError,
  TelemetryConflictError,
  TelemetryOutOfOrderError,
  type SessionId,
} from '../../src/domain/index.ts';
import { SimulatedChargerAdapter } from '../../src/infrastructure/charger/simulated-charger-adapter.ts';
import { InMemoryFlags, RecordingCharger } from '../support/fakes.ts';
import {
  CONNECTOR,
  SESSION_A,
  SESSION_B,
  SAGA_B,
  STATION,
  capturingLogger,
  createTestContext,
  reading,
  startCommand,
} from '../support/fixtures.ts';

const connectorKey = `${STATION}#${CONNECTOR}`;

function withRecordingCharger() {
  return createTestContext(new RecordingCharger());
}

function withSimulatedCharger() {
  const flags = new InMemoryFlags();
  const { logger, lines } = capturingLogger();
  const charger = new SimulatedChargerAdapter({ flags, logger });
  return { flags, lines, ...createTestContext(charger) };
}

describe('StartChargingSession', () => {
  it('inicio correcto: activa el cargador, registra ACTIVE y ocupa el conector', async () => {
    const ctx = withRecordingCharger();

    const result = await ctx.useCases.startChargingSession.execute(startCommand());

    expect(result.kind).toBe('STARTED');
    expect(result.session.status).toBe('ACTIVE');
    expect(ctx.charger.started).toHaveLength(1);
    expect(ctx.charger.started[0]?.requestedEnergy.wattHours).toBe(30_000);
    expect(ctx.sessions.connectors.get(connectorKey)).toBe(SESSION_A);
  });

  it('sesión duplicada (mismos términos): REPLAYED sin volver a llamar al cargador', async () => {
    const ctx = withRecordingCharger();
    const first = await ctx.useCases.startChargingSession.execute(startCommand());

    const second = await ctx.useCases.startChargingSession.execute(startCommand());

    expect(second).toEqual({ kind: 'REPLAYED', session: first.session });
    expect(ctx.charger.started).toHaveLength(1);
    expect(ctx.sessions.writes).toBe(1);
  });

  it('sesión duplicada con otros términos → IDEMPOTENCY_CONFLICT', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());

    await expect(
      ctx.useCases.startChargingSession.execute(startCommand({ energyKwh: 31 })),
    ).rejects.toBeInstanceOf(SessionTermsMismatchError);
    expect(ctx.charger.started).toHaveLength(1);
  });

  it('dos activaciones simultáneas del mismo id: una STARTED y otra REPLAYED', async () => {
    const ctx = withRecordingCharger();

    const results = await Promise.all([
      ctx.useCases.startChargingSession.execute(startCommand()),
      ctx.useCases.startChargingSession.execute(startCommand()),
    ]);

    expect(results.map((r) => r.kind).sort()).toEqual(['REPLAYED', 'STARTED']);
    expect(ctx.sessions.sessions.size).toBe(1);
    // El cargador es el mismo para la misma sesión: no se detiene al perdedor.
    expect(ctx.charger.stopped).toHaveLength(0);
  });

  it('conector ocupado por otra sesión → CONNECTOR_BUSY sin llamar al cargador', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());

    await expect(
      ctx.useCases.startChargingSession.execute(
        startCommand({ sessionId: SESSION_B, sagaId: SAGA_B }),
      ),
    ).rejects.toBeInstanceOf(ConnectorBusyError);
    expect(ctx.charger.started).toHaveLength(1);
  });

  it('si otra sesión ocupa el conector entre la lectura y la escritura, se detiene el cargador', async () => {
    const ctx = withRecordingCharger();
    ctx.sessions.beforeWrite = () => {
      ctx.sessions.connectors.set(connectorKey, SESSION_A as SessionId);
      ctx.sessions.beforeWrite = undefined;
    };

    await expect(
      ctx.useCases.startChargingSession.execute(
        startCommand({ sessionId: SESSION_B, sagaId: SAGA_B }),
      ),
    ).rejects.toBeInstanceOf(ConnectorBusyError);
    expect(ctx.charger.stopped.map((c) => c.sessionId)).toEqual([SESSION_B]);
    expect(ctx.sessions.sessions.has(SESSION_B)).toBe(false);
  });

  it('conflictos persistentes: 503 y el cargador no queda energizado sin registro', async () => {
    const ctx = withRecordingCharger();
    ctx.sessions.failNextWrites = 3;

    await expect(ctx.useCases.startChargingSession.execute(startCommand())).rejects.toBeInstanceOf(
      ConcurrentModificationError,
    );
    expect(ctx.charger.stopped.map((c) => c.sessionId)).toEqual([SESSION_A]);
    expect(ctx.sessions.sessions.size).toBe(0);
  });

  it('tras un aborto (tombstone) la activación tardía → SESSION_ABORTED', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.abortChargingSession.execute({ sessionId: SESSION_A });

    await expect(ctx.useCases.startChargingSession.execute(startCommand())).rejects.toBeInstanceOf(
      SessionAbortedError,
    );
    expect(ctx.charger.started).toHaveLength(0);
  });

  it('fallo TÉCNICO del cargador → ChargerUnavailableError (503) y nada registrado', async () => {
    const ctx = withRecordingCharger();
    ctx.charger.unavailable = true;

    await expect(ctx.useCases.startChargingSession.execute(startCommand())).rejects.toBeInstanceOf(
      ChargerUnavailableError,
    );
    expect(ctx.sessions.sessions.size).toBe(0);
    expect(ctx.sessions.connectors.size).toBe(0);
  });

  it('falla FÍSICA real (no simulada) → FAILED con simulated=false', async () => {
    const ctx = withRecordingCharger();
    ctx.charger.nextActivation = { kind: 'FAULT', fault: ChargerFault.of('E-PWR-002', false) };

    const { session } = await ctx.useCases.startChargingSession.execute(startCommand());

    expect(session.status).toBe('FAILED');
    expect(session.fault).toMatchObject({ code: 'E-PWR-002', simulated: false });
  });
});

describe('Fallo inducido por la flag SIMULATE_CHARGER_HARDWARE_FAULT', () => {
  it('con la flag activa: sesión FAILED con falla física simulada, clasificable y trazable', async () => {
    const ctx = withSimulatedCharger();
    ctx.flags.set('SIMULATE_CHARGER_HARDWARE_FAULT', true);

    const result = await ctx.useCases.startChargingSession.execute(startCommand());

    expect(result.kind).toBe('STARTED');
    expect(result.session.status).toBe('FAILED');
    expect(result.session.fault).toMatchObject({ code: 'E-HW-001', simulated: true });
    expect(ctx.sessions.connectors.size).toBe(0);
    expect(ctx.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'charger_fault',
        fault_class: 'PHYSICAL',
        fault_code: 'E-HW-001',
        simulated: true,
        cause: 'feature_flag:SIMULATE_CHARGER_HARDWARE_FAULT',
        session_id: SESSION_A,
      }),
    );
  });

  it('el valor se lee en cada activación: apagar la flag cambia el resultado sin reiniciar', async () => {
    const ctx = withSimulatedCharger();
    ctx.flags.set('SIMULATE_CHARGER_HARDWARE_FAULT', true);
    const failed = await ctx.useCases.startChargingSession.execute(startCommand());

    ctx.flags.set('SIMULATE_CHARGER_HARDWARE_FAULT', false);
    // La misma sesión sigue FAILED (idempotencia); una sesión nueva ya activa.
    const replay = await ctx.useCases.startChargingSession.execute(startCommand());
    const fresh = await ctx.useCases.startChargingSession.execute(
      startCommand({ sessionId: SESSION_B, sagaId: SAGA_B }),
    );

    expect(failed.session.status).toBe('FAILED');
    expect(replay).toMatchObject({ kind: 'REPLAYED', session: { status: 'FAILED' } });
    expect(fresh.session.status).toBe('ACTIVE');
  });

  it('el estado del cargador refleja la falla simulada', async () => {
    const ctx = withSimulatedCharger();
    ctx.flags.set('SIMULATE_CHARGER_HARDWARE_FAULT', true);

    const status = await ctx.useCases.getChargerStatus.execute({
      stationId: STATION,
      connectorId: CONNECTOR,
    });

    expect(status).toMatchObject({
      state: 'FAULTED',
      fault: { code: 'E-HW-001', simulated: true },
    });
  });
});

describe('StopChargingSession', () => {
  it('parada: COMPLETED con motivo, libera el conector y ordena parar al cargador', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());
    ctx.clock.advance(60_000);

    const result = await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'USER_REQUEST',
    });

    expect(result.outcome).toBe('STOPPED');
    expect(result.session).toMatchObject({ status: 'COMPLETED', stopReason: 'USER_REQUEST' });
    expect(result.session.transitions.map((t) => t.to)).toEqual(['ACTIVE', 'COMPLETED']);
    expect(ctx.sessions.connectors.size).toBe(0);
    expect(ctx.charger.stopped).toHaveLength(1);
  });

  it('parar dos veces es idempotente: ALREADY_STOPPED sin escrituras ni órdenes', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());
    await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'USER_REQUEST',
    });
    const writes = ctx.sessions.writes;

    const again = await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'OPERATOR_REQUEST',
    });

    expect(again.outcome).toBe('ALREADY_STOPPED');
    expect(again.session.stopReason).toBe('USER_REQUEST');
    expect(ctx.sessions.writes).toBe(writes);
    expect(ctx.charger.stopped).toHaveLength(1);
  });

  it('sesión inexistente → SESSION_NOT_FOUND; sesión FAILED → SESSION_NOT_ACTIVE', async () => {
    const ctx = withRecordingCharger();
    await expect(
      ctx.useCases.stopChargingSession.execute({ sessionId: SESSION_A, reason: 'USER_REQUEST' }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    ctx.charger.nextActivation = { kind: 'FAULT', fault: ChargerFault.of('E-HW-001', false) };
    await ctx.useCases.startChargingSession.execute(startCommand());
    await expect(
      ctx.useCases.stopChargingSession.execute({ sessionId: SESSION_A, reason: 'USER_REQUEST' }),
    ).rejects.toBeInstanceOf(SessionNotActiveError);
  });

  it('si el cargador no responde, la sesión sigue ACTIVE (se puede reintentar)', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());
    ctx.charger.unavailable = true;

    await expect(
      ctx.useCases.stopChargingSession.execute({ sessionId: SESSION_A, reason: 'USER_REQUEST' }),
    ).rejects.toBeInstanceOf(ChargerUnavailableError);
    expect(ctx.sessions.sessions.get(SESSION_A)?.session.status).toBe('ACTIVE');

    ctx.charger.unavailable = false;
    const retry = await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'USER_REQUEST',
    });
    expect(retry.outcome).toBe('STOPPED');
  });

  it('una escritura concurrente (p. ej. telemetría) se resuelve releyendo', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());
    ctx.sessions.failNextWrites = 1;

    const result = await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'USER_REQUEST',
    });

    expect(result.outcome).toBe('STOPPED');
  });
});

describe('AbortChargingSession (compensación)', () => {
  it('abortar dos veces: ABORTED y luego ALREADY_ABORTED sin efectos', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());

    const first = await ctx.useCases.abortChargingSession.execute({ sessionId: SESSION_A });
    const writes = ctx.sessions.writes;
    const second = await ctx.useCases.abortChargingSession.execute({ sessionId: SESSION_A });

    expect(first.outcome).toBe('ABORTED');
    expect(second.outcome).toBe('ALREADY_ABORTED');
    expect(ctx.sessions.writes).toBe(writes);
    expect(ctx.charger.stopped).toHaveLength(1);
    expect(ctx.sessions.connectors.size).toBe(0);
  });

  it('sin sesión deja un tombstone (VOIDED) y repetirlo no escribe', async () => {
    const ctx = withRecordingCharger();
    expect(await ctx.useCases.abortChargingSession.execute({ sessionId: SESSION_A })).toEqual({
      outcome: 'VOIDED',
    });
    const writes = ctx.sessions.writes;
    expect(await ctx.useCases.abortChargingSession.execute({ sessionId: SESSION_A })).toEqual({
      outcome: 'VOIDED',
    });
    expect(ctx.sessions.writes).toBe(writes);
  });

  it('una sesión FAILED → ALREADY_FAILED; una COMPLETED no es compensable', async () => {
    const ctx = withRecordingCharger();
    ctx.charger.nextActivation = { kind: 'FAULT', fault: ChargerFault.of('E-HW-001', false) };
    await ctx.useCases.startChargingSession.execute(startCommand());
    expect(
      (await ctx.useCases.abortChargingSession.execute({ sessionId: SESSION_A })).outcome,
    ).toBe('ALREADY_FAILED');

    ctx.charger.nextActivation = { kind: 'ACTIVATED' };
    await ctx.useCases.startChargingSession.execute(
      startCommand({ sessionId: SESSION_B, sagaId: SAGA_B }),
    );
    await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_B,
      reason: 'USER_REQUEST',
    });
    await expect(
      ctx.useCases.abortChargingSession.execute({ sessionId: SESSION_B }),
    ).rejects.toBeInstanceOf(SessionAlreadyCompletedError);
  });
});

describe('RecordTelemetry', () => {
  async function activeContext() {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());
    return ctx;
  }

  it('registra la lectura y la última lectura de la sesión', async () => {
    const ctx = await activeContext();

    const result = await ctx.useCases.recordTelemetry.execute({
      sessionId: SESSION_A,
      reading: reading(10_000, 1.5),
    });

    expect(result.outcome).toBe('RECORDED');
    expect(result.record).toMatchObject({ voltageV: 400, currentA: 145, powerKw: 58 });
    expect(ctx.sessions.sessions.get(SESSION_A)?.session.lastTelemetry?.energyKwh).toBe(1.5);
  });

  it('la misma lectura repetida → REPLAYED sin escribir; otra con el mismo timestamp → conflicto', async () => {
    const ctx = await activeContext();
    await ctx.useCases.recordTelemetry.execute({
      sessionId: SESSION_A,
      reading: reading(10_000, 1.5),
    });
    const writes = ctx.sessions.writes;

    const replay = await ctx.useCases.recordTelemetry.execute({
      sessionId: SESSION_A,
      reading: reading(10_000, 1.5),
    });
    expect(replay.outcome).toBe('REPLAYED');
    expect(ctx.sessions.writes).toBe(writes);

    await expect(
      ctx.useCases.recordTelemetry.execute({ sessionId: SESSION_A, reading: reading(10_000, 1.6) }),
    ).rejects.toBeInstanceOf(TelemetryConflictError);
  });

  it('telemetría inválida: rangos, incoherencia V × I o exceso de energía → nada escrito', async () => {
    const ctx = await activeContext();
    const writes = ctx.sessions.writes;
    const invalid = [
      reading(10_000, 1, { voltageV: 2_000 }),
      reading(10_000, 1, { currentA: -5 }),
      reading(10_000, 1, { powerKw: 150 }),
      reading(10_000, 31),
      reading(-10_000, 1),
    ];

    for (const value of invalid) {
      await expect(
        ctx.useCases.recordTelemetry.execute({ sessionId: SESSION_A, reading: value }),
      ).rejects.toBeInstanceOf(InvalidValueError);
    }
    expect(ctx.sessions.writes).toBe(writes);
    expect(ctx.sessions.telemetry.size).toBe(0);
  });

  it('fuera de orden → TELEMETRY_OUT_OF_ORDER', async () => {
    const ctx = await activeContext();
    await ctx.useCases.recordTelemetry.execute({
      sessionId: SESSION_A,
      reading: reading(20_000, 2),
    });

    await expect(
      ctx.useCases.recordTelemetry.execute({ sessionId: SESSION_A, reading: reading(10_000, 1) }),
    ).rejects.toBeInstanceOf(TelemetryOutOfOrderError);
  });

  it('sesión terminada no acepta lecturas nuevas, pero un reintento de una ya registrada es REPLAYED', async () => {
    const ctx = await activeContext();
    await ctx.useCases.recordTelemetry.execute({
      sessionId: SESSION_A,
      reading: reading(10_000, 1),
    });
    await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'USER_REQUEST',
    });

    expect(
      (
        await ctx.useCases.recordTelemetry.execute({
          sessionId: SESSION_A,
          reading: reading(10_000, 1),
        })
      ).outcome,
    ).toBe('REPLAYED');
    await expect(
      ctx.useCases.recordTelemetry.execute({ sessionId: SESSION_A, reading: reading(20_000, 2) }),
    ).rejects.toBeInstanceOf(SessionNotActiveError);
  });

  it('sesión inexistente → SESSION_NOT_FOUND', async () => {
    const ctx = withRecordingCharger();
    await expect(
      ctx.useCases.recordTelemetry.execute({ sessionId: SESSION_A, reading: reading(1_000, 1) }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('Consultas', () => {
  it('estado del cargador: IDLE → CHARGING (con la sesión) → IDLE', async () => {
    const ctx = withRecordingCharger();
    const query = { stationId: STATION, connectorId: CONNECTOR };

    expect((await ctx.useCases.getChargerStatus.execute(query)).state).toBe('IDLE');
    await ctx.useCases.startChargingSession.execute(startCommand());
    expect(await ctx.useCases.getChargerStatus.execute(query)).toMatchObject({
      state: 'CHARGING',
      activeSessionId: SESSION_A,
    });
    await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'USER_REQUEST',
    });
    expect((await ctx.useCases.getChargerStatus.execute(query)).state).toBe('IDLE');
  });

  it('sesiones activas e históricas de una estación', async () => {
    const ctx = withRecordingCharger();
    await ctx.useCases.startChargingSession.execute(startCommand());
    await ctx.useCases.stopChargingSession.execute({
      sessionId: SESSION_A,
      reason: 'USER_REQUEST',
    });
    ctx.clock.advance(1_000);
    await ctx.useCases.startChargingSession.execute(
      startCommand({ sessionId: SESSION_B, sagaId: SAGA_B }),
    );

    const active = await ctx.useCases.listStationSessions.execute({
      stationId: STATION,
      active: true,
      limit: 10,
    });
    const history = await ctx.useCases.listStationSessions.execute({
      stationId: STATION,
      active: false,
      limit: 10,
    });

    expect(active.items.map((s) => s.id)).toEqual([SESSION_B]);
    expect(history.items.map((s) => s.id)).toEqual([SESSION_B, SESSION_A]);
  });
});
