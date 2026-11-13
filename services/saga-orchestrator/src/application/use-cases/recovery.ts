import { SagaId, type SagaTransaction } from '../../domain/index.ts';
import { ConcurrentModificationError, SagaBusyError, SagaNotFoundError } from '../errors.ts';
import type { SagaRepository, Versioned } from '../ports/repositories.ts';
import type { Clock } from '../ports/services.ts';
import type { SagaExecutor } from '../saga-executor.ts';

export interface RecoveryOptions {
  /** Sin actividad durante este tiempo, una SAGA de avance se considera abandonada. */
  readonly staleAfterMs: number;
  /** Antes del pivote, una SAGA más antigua que esto se compensa en vez de avanzar. */
  readonly forwardDeadlineMs: number;
  /** Máximo de SAGAs examinadas por ejecución. */
  readonly batchSize: number;
}

export interface RecoveryReport {
  readonly examined: number;
  readonly recovered: readonly { sagaId: string; from: string; to: string }[];
  readonly skipped: number;
}

/**
 * Recuperación de SAGAs pendientes (job/worker o tarea controlada). Para cada
 * SAGA no terminal que debe retomarse:
 * 1. toma el *lease* con escritura condicional (si otra réplica lo tiene, la salta);
 * 2. registra `RECOVERED` (o el reintento automático de COMPENSATION_FAILED);
 * 3. antes del pivote y fuera de plazo, abandona el paso → compensación;
 * 4. la ejecuta desde el último estado persistido (llamadas idempotentes).
 */
export class RecoverPendingSagas {
  private readonly sagas: SagaRepository;
  private readonly executor: SagaExecutor;
  private readonly clock: Clock;
  private readonly options: RecoveryOptions;

  constructor(deps: {
    sagas: SagaRepository;
    executor: SagaExecutor;
    clock: Clock;
    options: RecoveryOptions;
  }) {
    this.sagas = deps.sagas;
    this.executor = deps.executor;
    this.clock = deps.clock;
    this.options = deps.options;
  }

  async execute(): Promise<RecoveryReport> {
    const candidates = await this.sagas.listNonTerminal(this.options.batchSize);
    const recovered: { sagaId: string; from: string; to: string }[] = [];
    let skipped = 0;

    for (const candidate of candidates) {
      if (!candidate.value.isDueForRecovery(this.clock.now(), this.options.staleAfterMs)) {
        skipped++;
        continue;
      }
      const result = await this.recoverOne(candidate.value.id);
      if (result === undefined) {
        skipped++;
      } else {
        recovered.push({
          sagaId: candidate.value.id,
          from: candidate.value.status,
          to: result.status,
        });
      }
    }
    return { examined: candidates.length, recovered, skipped };
  }

  private async recoverOne(sagaId: SagaId): Promise<SagaTransaction | undefined> {
    if (!(await this.sagas.acquireLease(sagaId, this.executor.lease(), this.clock.now()))) {
      return undefined;
    }
    try {
      const fresh = await this.sagas.find(sagaId);
      if (!fresh?.value.isDueForRecovery(this.clock.now(), this.options.staleAfterMs)) {
        await this.sagas.releaseLease(sagaId, this.executor.lease().owner);
        return undefined;
      }
      const now = this.clock.now();
      let next =
        fresh.value.status === 'COMPENSATION_FAILED'
          ? fresh.value.retryCompensation(now, 'AUTOMATIC')
          : fresh.value.markRecovered(now);
      if (next.exceedsForwardDeadline(now, this.options.forwardDeadlineMs)) {
        next = next.abandonStep('RECOVERY_DEADLINE_EXCEEDED', now);
      }
      const final = await this.executor.run(await this.executor.persist(fresh, next));
      await this.sagas.releaseLease(sagaId, this.executor.lease().owner);
      return final.value;
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        return undefined;
      }
      throw error;
    }
  }
}

/**
 * Reintento CONTROLADO de una SAGA en COMPENSATION_FAILED (operador): retoma la
 * compensación que falló, sin repetir las ya verificadas.
 */
export class RetryCompensation {
  private readonly sagas: SagaRepository;
  private readonly executor: SagaExecutor;
  private readonly clock: Clock;

  constructor(deps: { sagas: SagaRepository; executor: SagaExecutor; clock: Clock }) {
    this.sagas = deps.sagas;
    this.executor = deps.executor;
    this.clock = deps.clock;
  }

  async execute(rawSagaId: string): Promise<SagaTransaction> {
    const sagaId = SagaId.parse(rawSagaId);
    const stored = await this.sagas.find(sagaId);
    if (stored === undefined) {
      throw new SagaNotFoundError(`No existe la SAGA ${sagaId}`);
    }
    // Valida el estado antes de tomar el lease (SAGA_NOT_RETRYABLE).
    stored.value.retryCompensation(this.clock.now(), 'MANUAL');
    if (!(await this.sagas.acquireLease(sagaId, this.executor.lease(), this.clock.now()))) {
      throw new SagaBusyError(`La SAGA ${sagaId} la está ejecutando otra réplica`);
    }
    try {
      const fresh: Versioned<SagaTransaction> | undefined = await this.sagas.find(sagaId);
      if (fresh === undefined) {
        throw new SagaNotFoundError(`No existe la SAGA ${sagaId}`);
      }
      const resumed = await this.executor.persist(
        fresh,
        fresh.value.retryCompensation(this.clock.now(), 'MANUAL'),
      );
      const final = await this.executor.run(resumed);
      await this.sagas.releaseLease(sagaId, this.executor.lease().owner);
      return final.value;
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        throw new SagaBusyError(`La SAGA ${sagaId} cambió durante el reintento`, { cause: error });
      }
      throw error;
    }
  }
}
