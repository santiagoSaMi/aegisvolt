import type { TimelineItem } from '../../shared/ui/components.tsx';
import type { Saga } from '../charging/model.ts';
import type { SagaEvent } from './api.ts';

/** Filtra por fragmento de `sagaId` o `correlation_id` (búsqueda local sobre la página cargada). */
export function searchSagas(sagas: readonly Saga[], text: string): Saga[] {
  const needle = text.trim().toLowerCase();
  if (needle === '') {
    return [...sagas];
  }
  return sagas.filter(
    (s) =>
      s.sagaId.toLowerCase().includes(needle) || s.correlationId.toLowerCase().includes(needle),
  );
}

const EVENT_LABEL: Record<string, string> = {
  SAGA_STARTED: 'SAGA iniciada',
  STEP_STARTED: 'Paso iniciado',
  STEP_SUCCEEDED: 'Paso completado',
  STEP_FAILED: 'Paso fallido',
  COMPENSATION_STARTED: 'Inicio de compensación',
  COMPENSATION_STEP_STARTED: 'Compensación iniciada',
  COMPENSATION_SUCCEEDED: 'Compensación verificada',
  COMPENSATION_STEP_FAILED: 'Intento de compensación fallido',
  COMPENSATION_RETRY_REQUESTED: 'Reintento de compensación',
  SAGA_COMPLETED: 'SAGA completada',
  SAGA_COMPENSATED: 'SAGA compensada',
  SAGA_FAILED: 'SAGA fallida',
  SAGA_COMPENSATION_FAILED: 'Compensación fallida',
  RECOVERED: 'Recuperada tras reinicio',
};

/** Eventos del orquestador → línea de tiempo (en orden de secuencia). */
export function eventsTimeline(events: readonly SagaEvent[]): TimelineItem[] {
  return [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => ({
      key: String(event.sequence),
      title: `${EVENT_LABEL[event.type] ?? event.type}${event.step === null ? '' : ` · ${event.step}`}`,
      status: event.status,
      detail: [
        new Date(event.occurredAt).toLocaleTimeString('es-CO'),
        event.attempt === null ? undefined : `intento ${String(event.attempt)}`,
        event.errorCode ?? undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
}
