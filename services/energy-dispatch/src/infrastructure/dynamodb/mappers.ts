import {
  ChargerFault,
  ChargingSession,
  ConnectorId,
  RequestedEnergy,
  SagaId,
  SessionId,
  SessionTombstone,
  StationId,
  TelemetryRecord,
  type SessionStatus,
  type SessionTransition,
  type StopReason,
} from '../../domain/index.ts';
import { ENTITY, keys } from './table.ts';

/** Ítems tal como se guardan: el modelo de persistencia es privado del servicio. */
export interface SessionItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.session;
  sessionId: string;
  sagaId: string;
  stationId: string;
  connectorId: string;
  requestedWh: number;
  status: SessionStatus;
  faultCode?: string;
  faultSimulated?: boolean;
  stopReason?: StopReason;
  lastTelemetryAt?: string;
  lastEnergyKwh?: number;
  transitions: { from?: SessionStatus; to: SessionStatus; at: string; reason?: string }[];
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  version: number;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK?: string;
  GSI2SK?: string;
}

export interface SessionTombstoneItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.sessionTombstone;
  sessionId: string;
  voidedAt: string;
}

export interface TelemetryItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.telemetry;
  sessionId: string;
  timestamp: string;
  voltageV: number;
  currentA: number;
  powerKw: number;
  energyKwh: number;
  temperatureC?: number;
  ttl: number;
}

export function toSessionItem(session: ChargingSession, version: number): SessionItem {
  const { terms } = session;
  const startedAt = session.startedAt.toISOString();
  return {
    ...keys.session(session.id),
    entity: ENTITY.session,
    sessionId: session.id,
    sagaId: terms.sagaId,
    stationId: terms.stationId,
    connectorId: terms.connectorId,
    requestedWh: terms.requestedEnergy.wattHours,
    status: session.status,
    ...(session.fault === undefined
      ? {}
      : { faultCode: session.fault.code, faultSimulated: session.fault.simulated }),
    ...(session.stopReason === undefined ? {} : { stopReason: session.stopReason }),
    ...(session.lastTelemetry === undefined
      ? {}
      : {
          lastTelemetryAt: session.lastTelemetry.timestamp.toISOString(),
          lastEnergyKwh: session.lastTelemetry.energyKwh,
        }),
    transitions: session.transitions.map((t) => ({
      ...(t.from === undefined ? {} : { from: t.from }),
      to: t.to,
      at: t.at.toISOString(),
      ...(t.reason === undefined ? {} : { reason: t.reason }),
    })),
    startedAt,
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt.toISOString() }),
    updatedAt: session.updatedAt.toISOString(),
    version,
    GSI1PK: keys.stationHistory(terms.stationId),
    GSI1SK: `${startedAt}#${session.id}`,
    // Índice sparse de sesiones activas.
    ...(session.isActive
      ? {
          GSI2PK: keys.stationActive(terms.stationId),
          GSI2SK: `${terms.connectorId}#${session.id}`,
        }
      : {}),
  };
}

export function fromSessionItem(item: SessionItem): ChargingSession {
  const transitions: SessionTransition[] = item.transitions.map((t) => ({
    from: t.from,
    to: t.to,
    at: new Date(t.at),
    ...(t.reason === undefined ? {} : { reason: t.reason }),
  }));
  return ChargingSession.restore({
    id: SessionId.parse(item.sessionId),
    terms: {
      sagaId: SagaId.parse(item.sagaId),
      stationId: StationId.parse(item.stationId),
      connectorId: ConnectorId.parse(item.connectorId),
      requestedEnergy: RequestedEnergy.fromKwh(item.requestedWh / 1000),
    },
    status: item.status,
    ...(item.faultCode === undefined
      ? {}
      : { fault: ChargerFault.of(item.faultCode, item.faultSimulated ?? false) }),
    ...(item.stopReason === undefined ? {} : { stopReason: item.stopReason }),
    ...(item.lastTelemetryAt === undefined || item.lastEnergyKwh === undefined
      ? {}
      : {
          lastTelemetry: {
            timestamp: new Date(item.lastTelemetryAt),
            energyKwh: item.lastEnergyKwh,
          },
        }),
    transitions,
    startedAt: new Date(item.startedAt),
    ...(item.endedAt === undefined ? {} : { endedAt: new Date(item.endedAt) }),
    updatedAt: new Date(item.updatedAt),
  });
}

export function toTombstoneItem(tombstone: SessionTombstone): SessionTombstoneItem {
  return {
    ...keys.session(tombstone.id),
    entity: ENTITY.sessionTombstone,
    sessionId: tombstone.id,
    voidedAt: tombstone.voidedAt.toISOString(),
  };
}

export function fromTombstoneItem(item: SessionTombstoneItem): SessionTombstone {
  return SessionTombstone.create(SessionId.parse(item.sessionId), new Date(item.voidedAt));
}

export function toTelemetryItem(record: TelemetryRecord, retentionDays: number): TelemetryItem {
  const timestamp = record.timestamp.toISOString();
  return {
    ...keys.telemetry(record.sessionId, timestamp),
    entity: ENTITY.telemetry,
    sessionId: record.sessionId,
    timestamp,
    voltageV: record.voltageV,
    currentA: record.currentA,
    powerKw: record.powerKw,
    energyKwh: record.energyKwh,
    ...(record.temperatureC === undefined ? {} : { temperatureC: record.temperatureC }),
    ttl: Math.floor(record.timestamp.getTime() / 1000) + retentionDays * 86_400,
  };
}

export function fromTelemetryItem(item: TelemetryItem): TelemetryRecord {
  return TelemetryRecord.create(SessionId.parse(item.sessionId), {
    timestamp: new Date(item.timestamp),
    voltageV: item.voltageV,
    currentA: item.currentA,
    powerKw: item.powerKw,
    energyKwh: item.energyKwh,
    ...(item.temperatureC === undefined ? {} : { temperatureC: item.temperatureC }),
  });
}
