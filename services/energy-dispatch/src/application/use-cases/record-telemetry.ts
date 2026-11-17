import {
  SessionAbortedError,
  SessionId,
  TelemetryConflictError,
  TelemetryRecord,
  type TelemetryReading,
} from '../../domain/index.ts';
import { SessionNotFoundError } from '../errors.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { SessionRepository } from '../ports/repositories.ts';

export interface RecordTelemetryResult {
  /** RECORDED: lectura nueva · REPLAYED: misma lectura ya registrada (reintento). */
  readonly outcome: 'RECORDED' | 'REPLAYED';
  readonly record: TelemetryRecord;
}

/**
 * Registra una lectura del cargador. Idempotente por (`sessionId`, `timestamp`):
 * repetir la misma lectura → REPLAYED sin escribir (también si la sesión ya
 * terminó); otra lectura con el mismo `timestamp` → IDEMPOTENCY_CONFLICT.
 * La lectura y la última lectura de la sesión se guardan en una transacción
 * condicionada a la versión: dos lecturas simultáneas no pueden romper el orden.
 */
export class RecordTelemetry {
  private readonly sessions: SessionRepository;

  constructor(deps: { sessions: SessionRepository }) {
    this.sessions = deps.sessions;
  }

  async execute(command: {
    sessionId: string;
    reading: TelemetryReading;
  }): Promise<RecordTelemetryResult> {
    const sessionId = SessionId.parse(command.sessionId);
    return withOptimisticRetry(async () => {
      const stored = await this.sessions.findSession(sessionId);
      if (stored === undefined) {
        throw new SessionNotFoundError(`No existe la sesión ${sessionId}`);
      }
      if (stored.kind === 'TOMBSTONE') {
        throw new SessionAbortedError(`La sesión ${sessionId} fue abortada antes de activarse`);
      }

      const previous = await this.sessions.findTelemetry(sessionId, command.reading.timestamp);
      if (previous !== undefined) {
        if (previous.sameReadingAs(TelemetryRecord.create(sessionId, command.reading))) {
          return { outcome: 'REPLAYED', record: previous };
        }
        throw new TelemetryConflictError(
          `Ya hay otra lectura de ${sessionId} en ${command.reading.timestamp.toISOString()}`,
        );
      }

      const { value: session, version } = stored.session;
      const { session: updated, record } = session.recordTelemetry(command.reading);
      await this.sessions.saveTelemetry({ session: updated, expectedVersion: version, record });
      return { outcome: 'RECORDED', record };
    });
  }
}
