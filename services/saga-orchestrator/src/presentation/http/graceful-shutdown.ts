import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import type { Logger } from '@aegisvolt/logger';

/**
 * Readiness con "drenado": al iniciar el apagado deja de estar lista aunque las
 * dependencias respondan, para que Kubernetes saque el pod de los Endpoints
 * antes de cerrar el servidor.
 */
export class ReadinessGate {
  private draining = false;
  private readonly dependencies: () => Promise<boolean>;

  constructor(dependencies: () => Promise<boolean>) {
    this.dependencies = dependencies;
  }

  readonly check = async (): Promise<boolean> => !this.draining && (await this.dependencies());

  drain(): void {
    this.draining = true;
  }

  get isDraining(): boolean {
    return this.draining;
  }
}

export interface GracefulShutdownOptions {
  readonly server: Server;
  readonly readiness: ReadinessGate;
  readonly logger: Logger;
  /** Tiempo con readiness en 503 antes de cerrar (propagación a los Endpoints). */
  readonly drainDelayMs: number;
  /** Plazo máximo para que terminen las peticiones en curso; luego se cortan. */
  readonly graceMs: number;
  /** Liberación de recursos al final (clientes AWS…). */
  readonly onClosed?: () => void | Promise<void>;
}

/**
 * Apagado ordenado ante SIGTERM/SIGINT:
 * 1. readiness → 503 (deja de recibir tráfico nuevo del balanceador);
 * 2. espera `drainDelayMs`;
 * 3. deja de aceptar conexiones y espera a las peticiones en curso;
 * 4. si superan `graceMs`, corta las conexiones restantes;
 * 5. libera recursos. Idempotente: una segunda señal no repite el proceso.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions) {
  let shutdown: Promise<void> | undefined;

  const run = async (signal: string): Promise<void> => {
    const { server, readiness, logger } = options;
    logger.info('Apagado solicitado', {
      signal,
      drain_delay_ms: options.drainDelayMs,
      grace_ms: options.graceMs,
    });
    readiness.drain();
    await delay(options.drainDelayMs);

    const closed = new Promise<void>((resolve) => {
      server.close((error) => {
        if (error) {
          logger.error('Error al cerrar el servidor HTTP', { error: error.message });
          process.exitCode = 1;
        }
        resolve();
      });
    });
    // Las conexiones keep-alive que terminan su petición quedan ociosas DESPUÉS
    // de close(): se cierran periódicamente para no esperar al keepAliveTimeout.
    server.closeIdleConnections();
    const idleSweep = setInterval(() => {
      server.closeIdleConnections();
    }, 50);
    idleSweep.unref();
    const force = setTimeout(() => {
      logger.warn('Plazo de apagado agotado; se cortan las conexiones abiertas', {
        grace_ms: options.graceMs,
      });
      server.closeAllConnections();
    }, options.graceMs);
    force.unref();

    await closed;
    clearInterval(idleSweep);
    clearTimeout(force);
    await options.onClosed?.();
    logger.info('Servicio detenido');
  };

  return (signal: string): Promise<void> => {
    shutdown ??= run(signal);
    return shutdown;
  };
}
