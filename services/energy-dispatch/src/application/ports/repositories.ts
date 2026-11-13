import type {
  ChargingSession,
  ConnectorId,
  SessionId,
  SessionTombstone,
  StationId,
  TelemetryRecord,
} from '../../domain/index.ts';

/** Valor leído junto con su versión (concurrencia optimista). */
export interface Versioned<T> {
  readonly value: T;
  readonly version: number;
}

export type StoredSession =
  | { readonly kind: 'SESSION'; readonly session: Versioned<ChargingSession> }
  | { readonly kind: 'TOMBSTONE'; readonly tombstone: SessionTombstone };

export interface SessionPage {
  readonly items: readonly ChargingSession[];
  readonly nextCursor?: string;
}

/**
 * Persistencia propia del servicio (`aegisvolt-dispatch-<env>`). Todas las
 * escrituras son condicionales; si otra escritura ganó, lanzan
 * `ConcurrentModificationError` y no escriben nada.
 */
export interface SessionRepository {
  findSession(sessionId: SessionId): Promise<StoredSession | undefined>;
  /** Sesión que ocupa el conector, si hay una ACTIVE. */
  findActiveSessionOnConnector(
    stationId: StationId,
    connectorId: ConnectorId,
  ): Promise<SessionId | undefined>;

  /**
   * Registra una sesión nueva (id libre: ni sesión ni tombstone). Si está
   * ACTIVE, ocupa el conector en la misma transacción (falla si otra sesión lo ocupa).
   */
  saveStarted(session: ChargingSession): Promise<void>;
  /** Sesión terminada (COMPLETED o ABORTED) desde la versión leída; libera el conector. */
  saveEnded(input: { session: ChargingSession; expectedVersion: number }): Promise<void>;
  /** Lectura nueva + última lectura de la sesión, en una transacción. */
  saveTelemetry(input: {
    session: ChargingSession;
    expectedVersion: number;
    record: TelemetryRecord;
  }): Promise<void>;
  /** Anula un id de sesión que no existe (aborto antes de la activación). */
  saveTombstone(tombstone: SessionTombstone): Promise<void>;

  findTelemetry(sessionId: SessionId, timestamp: Date): Promise<TelemetryRecord | undefined>;
  /** Lecturas de la sesión, la más reciente primero. */
  listTelemetry(sessionId: SessionId, limit: number): Promise<readonly TelemetryRecord[]>;
  /** Sesiones de una estación: activas o histórico (más reciente primero). */
  listStationSessions(
    stationId: StationId,
    page: { active: boolean; limit: number; cursor?: string },
  ): Promise<SessionPage>;
}
