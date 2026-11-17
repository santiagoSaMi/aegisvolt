import type { energyDispatchV1 } from '@aegisvolt/contracts';
import type { z } from 'zod';

import type { ChargerStatus } from '../../application/index.ts';
import type { ChargingSession, TelemetryRecord } from '../../domain/index.ts';

/**
 * Dominio → vistas públicas del contrato energy-dispatch v1. Se tipan con
 * `z.input` del esquema: lo que el servidor envía es la entrada que valida el consumidor.
 */
type SessionView = z.input<typeof energyDispatchV1.sessionViewSchema>;
type TelemetryRecordView = z.input<typeof energyDispatchV1.telemetryRecordViewSchema>;
type ChargerStatusView = z.input<typeof energyDispatchV1.chargerStatusViewSchema>;

export function toSessionView(session: ChargingSession): SessionView {
  const { terms } = session;
  return {
    sessionId: session.id,
    sagaId: terms.sagaId,
    stationId: terms.stationId,
    connectorId: terms.connectorId,
    status: session.status,
    requestedEnergyKwh: terms.requestedEnergy.kwh,
    ...(session.fault === undefined
      ? {}
      : { fault: { code: session.fault.code, simulated: session.fault.simulated } }),
    ...(session.stopReason === undefined ? {} : { stopReason: session.stopReason }),
    ...(session.lastTelemetry === undefined
      ? {}
      : {
          energyDeliveredKwh: session.lastTelemetry.energyKwh,
          lastTelemetryAt: session.lastTelemetry.timestamp.toISOString(),
        }),
    transitions: session.transitions.map((transition) => ({
      ...(transition.from === undefined ? {} : { from: transition.from }),
      to: transition.to,
      at: transition.at.toISOString(),
      ...(transition.reason === undefined ? {} : { reason: transition.reason }),
    })),
    startedAt: session.startedAt.toISOString(),
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt.toISOString() }),
    updatedAt: session.updatedAt.toISOString(),
  };
}

export function toTelemetryView(record: TelemetryRecord): TelemetryRecordView {
  return {
    sessionId: record.sessionId,
    timestamp: record.timestamp.toISOString(),
    voltageV: record.voltageV,
    currentA: record.currentA,
    powerKw: record.powerKw,
    energyKwh: record.energyKwh,
    ...(record.temperatureC === undefined ? {} : { temperatureC: record.temperatureC }),
  };
}

export function toChargerStatusView(status: ChargerStatus): ChargerStatusView {
  return {
    stationId: status.stationId,
    connectorId: status.connectorId,
    state: status.state,
    ...(status.activeSessionId === undefined ? {} : { activeSessionId: status.activeSessionId }),
    ...(status.fault === undefined
      ? {}
      : { fault: { code: status.fault.code, simulated: status.fault.simulated } }),
    checkedAt: status.checkedAt.toISOString(),
  };
}
