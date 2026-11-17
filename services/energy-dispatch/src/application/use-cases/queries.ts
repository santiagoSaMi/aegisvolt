import {
  ConnectorId,
  SessionAbortedError,
  SessionId,
  StationId,
  type ChargerFault,
  type ChargingSession,
  type TelemetryRecord,
} from '../../domain/index.ts';
import { SessionNotFoundError } from '../errors.ts';
import type { SessionPage, SessionRepository } from '../ports/repositories.ts';
import type { ChargerAdapter, Clock } from '../ports/services.ts';

async function requireSession(
  sessions: SessionRepository,
  rawSessionId: string,
): Promise<ChargingSession> {
  const sessionId = SessionId.parse(rawSessionId);
  const stored = await sessions.findSession(sessionId);
  if (stored === undefined) {
    throw new SessionNotFoundError(`No existe la sesión ${sessionId}`);
  }
  if (stored.kind === 'TOMBSTONE') {
    throw new SessionAbortedError(`La sesión ${sessionId} fue abortada antes de activarse`);
  }
  return stored.session.value;
}

/** Consulta una sesión (la usa el orquestador para resolver un timeout antes de compensar). */
export class GetChargingSession {
  private readonly sessions: SessionRepository;

  constructor(deps: { sessions: SessionRepository }) {
    this.sessions = deps.sessions;
  }

  execute(sessionId: string): Promise<ChargingSession> {
    return requireSession(this.sessions, sessionId);
  }
}

/** Lecturas de telemetría de una sesión, la más reciente primero. */
export class ListSessionTelemetry {
  private readonly sessions: SessionRepository;

  constructor(deps: { sessions: SessionRepository }) {
    this.sessions = deps.sessions;
  }

  async execute(query: { sessionId: string; limit: number }): Promise<readonly TelemetryRecord[]> {
    const session = await requireSession(this.sessions, query.sessionId);
    return this.sessions.listTelemetry(session.id, query.limit);
  }
}

/** Sesiones activas o históricas de una estación. */
export class ListStationSessions {
  private readonly sessions: SessionRepository;

  constructor(deps: { sessions: SessionRepository }) {
    this.sessions = deps.sessions;
  }

  execute(query: {
    stationId: string;
    active: boolean;
    limit: number;
    cursor?: string | undefined;
  }): Promise<SessionPage> {
    return this.sessions.listStationSessions(StationId.parse(query.stationId), {
      active: query.active,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }
}

export type ChargerState = 'CHARGING' | 'IDLE' | 'FAULTED';

export interface ChargerStatus {
  readonly stationId: StationId;
  readonly connectorId: ConnectorId;
  readonly state: ChargerState;
  readonly activeSessionId?: SessionId;
  readonly fault?: ChargerFault;
  readonly checkedAt: Date;
}

/**
 * Estado de un cargador: combina lo que reporta el hardware (adaptador) con la
 * ocupación registrada por el servicio. Una falla del hardware tiene prioridad.
 */
export class GetChargerStatus {
  private readonly sessions: SessionRepository;
  private readonly charger: ChargerAdapter;
  private readonly clock: Clock;

  constructor(deps: { sessions: SessionRepository; charger: ChargerAdapter; clock: Clock }) {
    this.sessions = deps.sessions;
    this.charger = deps.charger;
    this.clock = deps.clock;
  }

  async execute(query: { stationId: string; connectorId: string }): Promise<ChargerStatus> {
    const stationId = StationId.parse(query.stationId);
    const connectorId = ConnectorId.parse(query.connectorId);
    const [hardware, activeSessionId] = await Promise.all([
      this.charger.getStatus({ stationId, connectorId }),
      this.sessions.findActiveSessionOnConnector(stationId, connectorId),
    ]);
    const base = {
      stationId,
      connectorId,
      checkedAt: this.clock.now(),
      ...(activeSessionId === undefined ? {} : { activeSessionId }),
    };
    if (hardware.kind === 'FAULTED') {
      return { ...base, state: 'FAULTED', fault: hardware.fault };
    }
    return { ...base, state: activeSessionId === undefined ? 'IDLE' : 'CHARGING' };
  }
}
