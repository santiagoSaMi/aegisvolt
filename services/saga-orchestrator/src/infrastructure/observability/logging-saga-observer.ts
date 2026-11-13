import { runWithLogContext, type Logger } from '@aegisvolt/logger';

import type { SagaObserver } from '../../application/index.ts';
import type { SagaEvent, SagaTransaction } from '../../domain/index.ts';

const WARN_EVENTS = new Set<SagaEvent['type']>([
  'STEP_FAILED',
  'COMPENSATION_STARTED',
  'COMPENSATION_STEP_FAILED',
  'SAGA_FAILED',
  'SAGA_COMPENSATED',
]);

/**
 * Registra cada evento persistido de la SAGA como una línea JSON con el
 * `correlation_id` ORIGINAL de la SAGA y su `saga_id` (también cuando la retoma
 * la recuperación): una búsqueda en CloudWatch devuelve el recorrido completo.
 */
export class LoggingSagaObserver implements SagaObserver {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'saga' });
  }

  transitioned(saga: SagaTransaction, events: readonly SagaEvent[]): void {
    runWithLogContext({ correlationId: saga.correlationId, sagaId: saga.id }, () => {
      for (const event of events) {
        const fields = {
          event: event.type,
          saga_status: event.status,
          sequence: event.sequence,
          ...(event.step === undefined ? {} : { step: event.step }),
          ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
          ...(event.errorCode === undefined ? {} : { error_code: event.errorCode }),
        };
        if (event.type === 'SAGA_COMPENSATION_FAILED') {
          this.logger.error('Compensación de la SAGA fallida', {
            ...fields,
            compensation_failure: saga.compensationFailure?.detail,
            next_attempt_at: saga.compensationFailure?.nextAttemptAt?.toISOString(),
          });
        } else if (WARN_EVENTS.has(event.type)) {
          this.logger.warn('Evento de la SAGA', fields);
        } else {
          this.logger.info('Evento de la SAGA', fields);
        }
      }
    });
  }
}
