import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { toUiError } from '../../shared/api/errors.ts';
import { formatDateTime, shortId } from '../../shared/format/format.ts';
import { useFleetScope } from '../../shared/hooks/useFleetScope.ts';
import { useViewerContext } from '../../shared/hooks/useViewerContext.ts';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
  TextField,
  Timeline,
} from '../../shared/ui/components.tsx';
import { FleetScopeField } from '../../shared/ui/FleetScopeField.tsx';
import { failureText } from '../charging/model.ts';
import { useFleetSagas, useSagaHistory } from './api.ts';
import { eventsTimeline, searchSagas } from './model.ts';

const STATUSES = ['COMPLETED', 'COMPENSATED', 'FAILED', 'COMPENSATION_FAILED', 'COMPENSATING'];

function SagaDetail({ sagaId }: { sagaId: string }) {
  const { saga, loading, error } = useSagaHistory(sagaId);
  if (loading && saga === undefined) {
    return <LoadingState />;
  }
  if (error !== undefined) {
    return <ErrorState error={toUiError(error)} />;
  }
  if (saga === null || saga === undefined) {
    return <EmptyState title="La SAGA no existe o no es visible para su flota" />;
  }
  return (
    <Card title="Historial de la SAGA" actions={<StatusBadge status={saga.status} />}>
      <dl className="facts facts--compact">
        <dt>SAGA</dt>
        <dd>
          <code>{saga.sagaId}</code>
        </dd>
        <dt>correlation_id</dt>
        <dd>
          <code data-testid="saga-correlation-id">{saga.correlationId}</code>{' '}
          <Button
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(saga.correlationId)}
          >
            Copiar
          </Button>
        </dd>
        <dt>Motivo de fallo</dt>
        <dd>{saga.failureReason === null ? '—' : failureText(saga.failureReason)}</dd>
        <dt>Plan de compensación</dt>
        <dd>{saga.compensationPlan.length === 0 ? '—' : saga.compensationPlan.join(' → ')}</dd>
      </dl>
      {saga.compensationFailure === null ? null : (
        <Alert tone="danger" title={`Compensación fallida: ${saga.compensationFailure.step}`}>
          Error {saga.compensationFailure.errorCode}.{' '}
          {saga.compensationFailure.nextAttemptAt === null
            ? 'Requiere un reintento controlado por un operador.'
            : `Próximo reintento automático: ${formatDateTime(saga.compensationFailure.nextAttemptAt)}.`}
        </Alert>
      )}
      <Timeline items={eventsTimeline(saga.events)} label="Eventos de la SAGA" />
      <p className="muted small">
        Para rastrear la operación en los logs (CloudWatch) filtre por este correlation_id.
      </p>
    </Card>
  );
}

/** Historial de SAGAs de la flota: estados, correlation_id, errores y compensaciones. */
export function ObservabilityPage() {
  const viewer = useViewerContext();
  const scope = useFleetScope(viewer);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const selected = params.get('saga') ?? undefined;
  const { sagas, loading, error, refetch } = useFleetSagas(
    scope.fleetId,
    status === '' ? undefined : status,
  );

  return (
    <>
      <PageHeader
        title="Observabilidad"
        description="Historial de SAGAs, correlation_id, errores y compensaciones."
      />
      <Card>
        <div className="toolbar">
          <FleetScopeField scope={scope} />
          <SelectField
            label="Estado"
            value={status}
            placeholder="Todos"
            options={STATUSES.map((s) => ({ value: s, label: s }))}
            onChange={(event) => {
              setStatus(event.target.value);
            }}
          />
          <TextField
            label="Buscar por sagaId o correlation_id"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      </Card>
      <div className="grid-2">
        <div>
          {scope.fleetId === undefined ? <EmptyState title="Indique una flota" /> : null}
          {loading && sagas === undefined ? <LoadingState /> : null}
          {error === undefined ? null : (
            <ErrorState error={toUiError(error)} onRetry={() => void refetch()} />
          )}
          {sagas === undefined ? null : (
            <Card title="SAGAs recientes">
              <DataTable
                caption="SAGAs de la flota"
                rows={searchSagas(sagas, search)}
                rowKey={(s) => s.sagaId}
                empty="No hay SAGAs para estos filtros"
                columns={[
                  { header: 'Fecha', cell: (s) => formatDateTime(s.createdAt) },
                  { header: 'Estado', cell: (s) => <StatusBadge status={s.status} /> },
                  {
                    header: 'SAGA',
                    cell: (s) => (
                      <button
                        type="button"
                        className="link-button"
                        aria-pressed={selected === s.sagaId}
                        title={s.sagaId}
                        onClick={() => {
                          setParams({ saga: s.sagaId });
                        }}
                      >
                        {shortId(s.sagaId)}
                      </button>
                    ),
                  },
                  {
                    header: 'Motivo',
                    cell: (s) => (s.failureReason === null ? '—' : failureText(s.failureReason)),
                  },
                ]}
              />
            </Card>
          )}
        </div>
        <div>
          {selected === undefined ? (
            <EmptyState title="Seleccione una SAGA para ver su historial" />
          ) : (
            <SagaDetail sagaId={selected} />
          )}
        </div>
      </div>
    </>
  );
}
