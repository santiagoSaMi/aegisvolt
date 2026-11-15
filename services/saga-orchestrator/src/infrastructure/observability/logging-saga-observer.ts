import { runWithLogContext, type Logger } from '@aegisvolt/logger';

import type { SagaObserver } from '../../application/index.ts';
import type { SagaEvent, SagaTransaction } from '../../domain/index.ts';

/** Eventos terminales: llevan `duration_ms` (desde la creación de la SAGA) para la métrica SagaDuration. */
const TERMINAL_EVENTS = new Set<SagaEvent['type']>([
  'SAGA_COMPLETED',
  'SAGA_COMPENSATED',
  'SAGA_FAILED',
  'SAGA_COMPENSATION_FAILED',
]);

const WARN_EVENTS = new Set<SagaEvent['type']>([
  'STEP_FAILED',
  'COMPENSATION_STARTED',
  'COMPENSATION_STEP_FAILED',
  'SAGA_FAILED',
  'SAGA_COMPENSATED',
]);

/** Operación de negocio de la SAGA (el único tipo de SAGA del sistema). */
const SAGA_OPERATION = 'ReserveAndActivateCharging';

/**
 * Registra cada evento persistido de la SAGA como una línea JSON con el
 * `correlation_id` ORIGINAL de la SAGA, su `saga_id` y `operation` (también
 * cuando la retoma la recuperación): una búsqueda en CloudWatch por
 * `correlation_id` o `saga_id` devuelve el recorrido completo. Los fallos de
 * paso y de compensación llevan un `error` tipado con el código del servicio.
 */
export class LoggingSagaObserver implements SagaObserver {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'saga' });
  }

  transitioned(saga: SagaTransaction, events: readonly SagaEvent[]): void {
    runWithLogContext(
      { correlationId: saga.correlationId, sagaId: saga.id, operation: SAGA_OPERATION },
      () => {
        for (const event of events) {
          const fields = {
            event: event.type,
            saga_status: event.status,
            sequence: event.sequence,
            ...(event.step === undefined ? {} : { step: event.step }),
            ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
            ...(TERMINAL_EVENTS.has(event.type)
              ? { duration_ms: Math.max(0, event.occurredAt.getTime() - saga.createdAt.getTime()) }
              : {}),
            ...(event.errorCode === undefined
              ? {}
              : {
                  error: {
                    type: 'SagaStepFailure',
                    code: event.errorCode,
                    message: `Paso ${event.step ?? '-'} fallido`,
                  },
                }),
          };
          if (event.type === 'SAGA_COMPENSATION_FAILED') {
            const failure = saga.compensationFailure;
            this.logger.error('Compensación de la SAGA fallida', {
              ...fields,
              error: {
                type: 'SagaCompensationFailure',
                code: failure?.errorCode ?? event.errorCode ?? 'UNKNOWN',
                message: failure?.detail ?? 'Compensación fallida',
              },
              next_attempt_at: failure?.nextAttemptAt?.toISOString(),
            });
          } else if (WARN_EVENTS.has(event.type)) {
            this.logger.warn('Evento de la SAGA', fields);
          } else {
            this.logger.info('Evento de la SAGA', fields);
          }
        }
      },
    );
  }
}
