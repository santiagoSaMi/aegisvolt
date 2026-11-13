import {
  ConcurrentModificationError,
  type SessionPage,
  type SessionRepository,
  type StoredSession,
} from '../../src/application/index.ts';
import type {
  ChargingSession,
  ConnectorId,
  SessionId,
  SessionTombstone,
  StationId,
  TelemetryRecord,
} from '../../src/domain/index.ts';

/**
 * Repositorio en memoria con las MISMAS condiciones que el adaptador DynamoDB
 * (ids nuevos, versión leída, ocupación del conector): si una condición falla
 * lanza `ConcurrentModificationError` sin escribir nada.
 */
export class InMemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, { session: ChargingSession; version: number }>();
  readonly tombstones = new Map<string, SessionTombstone>();
  readonly connectors = new Map<string, SessionId>();
  readonly telemetry = new Map<string, TelemetryRecord>();
  writes = 0;
  /** Hace fallar las próximas N escrituras (simula otra réplica que gana la carrera). */
  failNextWrites = 0;
  /** Se ejecuta antes de cada escritura (para inyectar escrituras concurrentes). */
  beforeWrite: (() => void) | undefined;

  private static connectorKey(stationId: string, connectorId: string): string {
    return `${stationId}#${connectorId}`;
  }

  findSession(sessionId: SessionId): Promise<StoredSession | undefined> {
    const tombstone = this.tombstones.get(sessionId);
    if (tombstone !== undefined) {
      return Promise.resolve({ kind: 'TOMBSTONE', tombstone });
    }
    const stored = this.sessions.get(sessionId);
    return Promise.resolve(
      stored === undefined
        ? undefined
        : { kind: 'SESSION', session: { value: stored.session, version: stored.version } },
    );
  }

  findActiveSessionOnConnector(
    stationId: StationId,
    connectorId: ConnectorId,
  ): Promise<SessionId | undefined> {
    return Promise.resolve(
      this.connectors.get(InMemorySessionRepository.connectorKey(stationId, connectorId)),
    );
  }

  saveStarted(session: ChargingSession): Promise<void> {
    return this.write(() => {
      const connector = InMemorySessionRepository.connectorKey(
        session.terms.stationId,
        session.terms.connectorId,
      );
      const occupant = this.connectors.get(connector);
      if (
        this.sessions.has(session.id) ||
        this.tombstones.has(session.id) ||
        (session.isActive && occupant !== undefined && occupant !== session.id)
      ) {
        throw new ConcurrentModificationError('condición fallida');
      }
      this.sessions.set(session.id, { session, version: 1 });
      if (session.isActive) {
        this.connectors.set(connector, session.id);
      }
    });
  }

  saveEnded(input: { session: ChargingSession; expectedVersion: number }): Promise<void> {
    return this.write(() => {
      const { session, expectedVersion } = input;
      const connector = InMemorySessionRepository.connectorKey(
        session.terms.stationId,
        session.terms.connectorId,
      );
      const occupant = this.connectors.get(connector);
      if (
        this.sessions.get(session.id)?.version !== expectedVersion ||
        (occupant !== undefined && occupant !== session.id)
      ) {
        throw new ConcurrentModificationError('condición fallida');
      }
      this.sessions.set(session.id, { session, version: expectedVersion + 1 });
      this.connectors.delete(connector);
    });
  }

  saveTelemetry(input: {
    session: ChargingSession;
    expectedVersion: number;
    record: TelemetryRecord;
  }): Promise<void> {
    return this.write(() => {
      const key = `${input.record.sessionId}#${input.record.timestamp.toISOString()}`;
      if (
        this.sessions.get(input.session.id)?.version !== input.expectedVersion ||
        this.telemetry.has(key)
      ) {
        throw new ConcurrentModificationError('condición fallida');
      }
      this.sessions.set(input.session.id, {
        session: input.session,
        version: input.expectedVersion + 1,
      });
      this.telemetry.set(key, input.record);
    });
  }

  saveTombstone(tombstone: SessionTombstone): Promise<void> {
    return this.write(() => {
      if (this.sessions.has(tombstone.id) || this.tombstones.has(tombstone.id)) {
        throw new ConcurrentModificationError('condición fallida');
      }
      this.tombstones.set(tombstone.id, tombstone);
    });
  }

  findTelemetry(sessionId: SessionId, timestamp: Date): Promise<TelemetryRecord | undefined> {
    return Promise.resolve(this.telemetry.get(`${sessionId}#${timestamp.toISOString()}`));
  }

  listTelemetry(sessionId: SessionId, limit: number): Promise<readonly TelemetryRecord[]> {
    return Promise.resolve(
      [...this.telemetry.values()]
        .filter((record) => record.sessionId === sessionId)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit),
    );
  }

  listStationSessions(
    stationId: StationId,
    page: { active: boolean; limit: number },
  ): Promise<SessionPage> {
    const items = [...this.sessions.values()]
      .map(({ session }) => session)
      .filter((s) => s.terms.stationId === stationId && (!page.active || s.isActive))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, page.limit);
    return Promise.resolve({ items });
  }

  private write(apply: () => void): Promise<void> {
    this.beforeWrite?.();
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      return Promise.reject(new ConcurrentModificationError('escritura concurrente simulada'));
    }
    try {
      apply();
      this.writes++;
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
