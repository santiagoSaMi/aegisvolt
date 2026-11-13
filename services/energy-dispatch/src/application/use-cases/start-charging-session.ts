import {
  ConnectorBusyError,
  ConnectorId,
  RequestedEnergy,
  SagaId,
  SessionId,
  StationId,
  ensureCanStart,
  startSession,
  type ChargerActivationResult,
  type ChargingSession,
  type SessionTerms,
} from '../../domain/index.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { SessionRepository } from '../ports/repositories.ts';
import type { ChargerAdapter, Clock } from '../ports/services.ts';

export interface StartChargingSessionCommand {
  readonly sessionId: string;
  readonly sagaId: string;
  readonly stationId: string;
  readonly connectorId: string;
  readonly energyKwh: number;
}

/**
 * - STARTED: esta petición activó (o intentó activar) el cargador; la sesión
 *   quedó ACTIVE o FAILED (falla física).
 * - REPLAYED: la sesión ya existía con los mismos términos; no se llamó al cargador.
 */
export interface StartChargingSessionResult {
  readonly kind: 'STARTED' | 'REPLAYED';
  readonly session: ChargingSession;
}

/**
 * Paso 3 de la SAGA (pivote): activa el cargador y registra la sesión.
 *
 * Idempotencia: el `sessionId` lo pre-genera el orquestador. Un reintento con
 * los mismos términos devuelve la sesión registrada SIN volver a llamar al
 * cargador; con otros términos → IDEMPOTENCY_CONFLICT; tras un aborto → SESSION_ABORTED.
 *
 * Concurrencia: la sesión se crea con `attribute_not_exists` y, si queda ACTIVE,
 * ocupa el conector en la misma transacción. Si otra petición gana, se relee y
 * se decide de nuevo (replay, conector ocupado o tombstone).
 *
 * Si esta petición energizó el cargador pero la sesión no quedó registrada como
 * ACTIVE por ella (perdió la carrera, la persistencia falló), se le ordena parar
 * a esa sesión (best-effort): el cargador nunca queda entregando energía sin registro.
 */
export class StartChargingSession {
  private readonly sessions: SessionRepository;
  private readonly charger: ChargerAdapter;
  private readonly clock: Clock;

  constructor(deps: { sessions: SessionRepository; charger: ChargerAdapter; clock: Clock }) {
    this.sessions = deps.sessions;
    this.charger = deps.charger;
    this.clock = deps.clock;
  }

  async execute(command: StartChargingSessionCommand): Promise<StartChargingSessionResult> {
    const sessionId = SessionId.parse(command.sessionId);
    const terms: SessionTerms = {
      sagaId: SagaId.parse(command.sagaId),
      stationId: StationId.parse(command.stationId),
      connectorId: ConnectorId.parse(command.connectorId),
      requestedEnergy: RequestedEnergy.fromKwh(command.energyKwh),
    };
    const target = { sessionId, stationId: terms.stationId, connectorId: terms.connectorId };
    // Objeto (no `let`): se modifica dentro del closure del reintento.
    const attempt = { energized: false };

    let result: StartChargingSessionResult;
    try {
      result = await withOptimisticRetry(async () => {
        const stored = await this.sessions.findSession(sessionId);
        const existing = stored?.kind === 'SESSION' ? stored.session.value : undefined;
        const tombstone = stored?.kind === 'TOMBSTONE' ? stored.tombstone : undefined;
        const replay = ensureCanStart({ sessionId, terms, existing, tombstone });
        if (replay !== undefined) {
          return { kind: 'REPLAYED', session: replay };
        }

        const occupant = await this.sessions.findActiveSessionOnConnector(
          terms.stationId,
          terms.connectorId,
        );
        if (occupant !== undefined && occupant !== sessionId) {
          throw new ConnectorBusyError(
            `El conector ${terms.connectorId} de ${terms.stationId} ya tiene una sesión activa`,
          );
        }

        const activation: ChargerActivationResult = await this.charger.startCharging({
          ...target,
          requestedEnergy: terms.requestedEnergy,
        });
        attempt.energized ||= activation.kind === 'ACTIVATED';

        const started = startSession({
          sessionId,
          terms,
          existing: undefined,
          tombstone: undefined,
          activation,
          now: this.clock.now(),
        });
        await this.sessions.saveStarted(started.session);
        return { kind: 'STARTED', session: started.session };
      });
    } catch (error) {
      if (attempt.energized) {
        await this.stopQuietly(target);
      }
      throw error;
    }

    // Energizado por esta petición, pero la sesión registrada no está ACTIVE
    // (p. ej. otra petición con el mismo id registró una falla): se detiene.
    if (attempt.energized && !result.session.isActive) {
      await this.stopQuietly(target);
    }
    return result;
  }

  private async stopQuietly(target: Parameters<ChargerAdapter['stopCharging']>[0]) {
    // Best-effort: el error original es el relevante; el adaptador registra sus fallos.
    await this.charger.stopCharging(target).catch(() => undefined);
  }
}
