import {
  SessionAbortedError,
  SessionId,
  abortSession,
  type AbortOutcome,
  type ChargingSession,
  type StopOutcome,
  type StopReason,
} from '../../domain/index.ts';
import { SessionNotFoundError } from '../errors.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { SessionRepository } from '../ports/repositories.ts';
import type { ChargerAdapter, Clock } from '../ports/services.ts';

interface Deps {
  sessions: SessionRepository;
  charger: ChargerAdapter;
  clock: Clock;
}

export interface StopChargingSessionResult {
  readonly outcome: StopOutcome;
  readonly session: ChargingSession;
}

/**
 * Parada normal (usuario, operador u objetivo alcanzado): ACTIVE → COMPLETED.
 * Idempotente: parar una sesión ya COMPLETED devuelve ALREADY_STOPPED sin
 * escribir ni llamar al cargador. Orden: primero se ordena parar al cargador y
 * luego se registra; si el cargador no responde (503) no se escribe nada y el
 * reintento vuelve a intentarlo (la orden de parada es idempotente).
 */
export class StopChargingSession {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async execute(command: {
    sessionId: string;
    reason: StopReason;
  }): Promise<StopChargingSessionResult> {
    const sessionId = SessionId.parse(command.sessionId);
    return withOptimisticRetry(async () => {
      const stored = await this.deps.sessions.findSession(sessionId);
      if (stored === undefined) {
        throw new SessionNotFoundError(`No existe la sesión ${sessionId}`);
      }
      if (stored.kind === 'TOMBSTONE') {
        throw new SessionAbortedError(`La sesión ${sessionId} fue abortada antes de activarse`);
      }
      const { value: session, version } = stored.session;
      const result = session.stop(command.reason, this.deps.clock.now());
      if (result.outcome === 'STOPPED') {
        await this.deps.charger.stopCharging({
          sessionId,
          stationId: session.terms.stationId,
          connectorId: session.terms.connectorId,
        });
        await this.deps.sessions.saveEnded({ session: result.session, expectedVersion: version });
      }
      return result;
    });
  }
}

export type AbortChargingSessionResult =
  | { readonly outcome: AbortOutcome; readonly session: ChargingSession }
  | { readonly outcome: 'VOIDED' };

/**
 * Compensación de la SAGA (idempotente): aborta la sesión ACTIVE y libera el
 * conector. Sin sesión deja un tombstone que impide una activación tardía; un
 * segundo aborto devuelve el mismo resultado sin efectos (ALREADY_* o VOIDED).
 */
export class AbortChargingSession {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async execute(command: { sessionId: string }): Promise<AbortChargingSessionResult> {
    const sessionId = SessionId.parse(command.sessionId);
    return withOptimisticRetry(async () => {
      const stored = await this.deps.sessions.findSession(sessionId);
      if (stored?.kind === 'TOMBSTONE') {
        return { outcome: 'VOIDED' };
      }
      const decision = abortSession({
        sessionId,
        session: stored?.session.value,
        now: this.deps.clock.now(),
      });
      if (decision.outcome === 'VOIDED') {
        await this.deps.sessions.saveTombstone(decision.tombstone);
        return { outcome: 'VOIDED' };
      }
      if (decision.outcome === 'ABORTED' && stored !== undefined) {
        const { session } = decision;
        await this.deps.charger.stopCharging({
          sessionId,
          stationId: session.terms.stationId,
          connectorId: session.terms.connectorId,
        });
        await this.deps.sessions.saveEnded({ session, expectedVersion: stored.session.version });
      }
      return { outcome: decision.outcome, session: decision.session };
    });
  }
}
