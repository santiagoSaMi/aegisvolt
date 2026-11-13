import type { Logger } from '@aegisvolt/logger';

import type { RecoverPendingSagas } from '../../application/index.ts';

/**
 * Worker de recuperación en proceso: ejecuta `RecoverPendingSagas` al arrancar y
 * cada `intervalMs`, sin solaparse consigo mismo. Varias réplicas pueden
 * ejecutarlo a la vez: el *lease* condicional reparte las SAGAs.
 */
export class RecoveryWorker {
  private readonly recover: RecoverPendingSagas;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(deps: { recover: RecoverPendingSagas; logger: Logger; intervalMs: number }) {
    this.recover = deps.recover;
    this.logger = deps.logger.child({ component: 'recovery-worker' });
    this.intervalMs = deps.intervalMs;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Detiene el intervalo y espera a la ronda en curso (apagado ordenado). */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  private async tick(): Promise<void> {
    if (this.running !== undefined) {
      return;
    }
    this.running = this.recover
      .execute()
      .then((report) => {
        if (report.recovered.length > 0) {
          this.logger.info('SAGAs recuperadas', {
            event: 'saga_recovery',
            examined: report.examined,
            recovered: report.recovered,
            skipped: report.skipped,
          });
        }
      })
      .catch((error: unknown) => {
        this.logger.error('Fallo en la recuperación de SAGAs', {
          event: 'saga_recovery_failed',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      })
      .finally(() => {
        this.running = undefined;
      });
    await this.running;
  }
}
