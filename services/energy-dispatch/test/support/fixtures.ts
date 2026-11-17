import { createLogger, type Logger } from '@aegisvolt/logger';

import {
  AbortChargingSession,
  GetChargerStatus,
  GetChargingSession,
  ListSessionTelemetry,
  ListStationSessions,
  RecordTelemetry,
  StartChargingSession,
  StopChargingSession,
  type ChargerAdapter,
} from '../../src/application/index.ts';
import type { TelemetryReading } from '../../src/domain/index.ts';
import { FixedClock, RecordingCharger } from './fakes.ts';
import { InMemorySessionRepository } from './in-memory-session-repository.ts';

export const START = new Date('2026-11-13T15:00:00.000Z');
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const SESSION_A = `ses_${uuid(1)}`;
export const SESSION_B = `ses_${uuid(2)}`;
export const SAGA_A = `saga_${uuid(1)}`;
export const SAGA_B = `saga_${uuid(2)}`;
export const STATION = 'st_bog-norte-01';
export const CONNECTOR = 'cn_01';

export const startCommand = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION_A,
  sagaId: SAGA_A,
  stationId: STATION,
  connectorId: CONNECTOR,
  energyKwh: 30,
  ...overrides,
});

/** Lectura coherente: 400 V × 145 A = 58 kW. */
export const reading = (
  offsetMs: number,
  energyKwh: number,
  overrides: Partial<TelemetryReading> = {},
): TelemetryReading => ({
  timestamp: new Date(START.getTime() + offsetMs),
  voltageV: 400,
  currentA: 145,
  powerKw: 58,
  energyKwh,
  temperatureC: 35,
  ...overrides,
});

/** Logger silencioso que conserva las líneas para inspeccionarlas. */
export function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'energy-dispatch-service',
    environment: 'test',
    version: 'test',
    level: 'debug',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines };
}

/** Casos de uso sobre el repositorio en memoria y un cargador controlable. */
export function createTestContext<TCharger extends ChargerAdapter = RecordingCharger>(
  charger: TCharger = new RecordingCharger() as unknown as TCharger,
) {
  const sessions = new InMemorySessionRepository();
  const clock = new FixedClock(START);
  return {
    sessions,
    clock,
    charger,
    useCases: {
      startChargingSession: new StartChargingSession({ sessions, charger, clock }),
      stopChargingSession: new StopChargingSession({ sessions, charger, clock }),
      abortChargingSession: new AbortChargingSession({ sessions, charger, clock }),
      recordTelemetry: new RecordTelemetry({ sessions }),
      getChargingSession: new GetChargingSession({ sessions }),
      listSessionTelemetry: new ListSessionTelemetry({ sessions }),
      listStationSessions: new ListStationSessions({ sessions }),
      getChargerStatus: new GetChargerStatus({ sessions, charger, clock }),
    },
  };
}
