import { useState } from 'react';
import { Link } from 'react-router';

import { toUiError } from '../../shared/api/errors.ts';
import { formatDateTime, formatMoney, shortId } from '../../shared/format/format.ts';
import { useFleetScope } from '../../shared/hooks/useFleetScope.ts';
import { useViewerContext } from '../../shared/hooks/useViewerContext.ts';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
} from '../../shared/ui/components.tsx';
import { FleetScopeField } from '../../shared/ui/FleetScopeField.tsx';
import { failureText } from '../charging/model.ts';
import { useTransactions } from './api.ts';
import { filterTransactions, problematicSagas, type TransactionFilter } from './model.ts';

export function TransactionsPage() {
  const viewer = useViewerContext();
  const scope = useFleetScope(viewer);
  const [filter, setFilter] = useState<TransactionFilter>('ALL');
  const { data, loading, error, refetch, loadMore } = useTransactions(scope.fleetId);

  return (
    <>
      <PageHeader
        title="Historial de transacciones"
        description="Débitos, reembolsos y recargas del libro mayor, y operaciones con error o compensación."
      />
      <Card>
        <div className="toolbar">
          <FleetScopeField scope={scope} />
          <SelectField
            label="Tipo"
            value={filter}
            options={[
              { value: 'ALL', label: 'Todos' },
              { value: 'DEBIT', label: 'Débitos' },
              { value: 'REFUND', label: 'Reembolsos' },
              { value: 'TOP_UP', label: 'Recargas' },
            ]}
            onChange={(event) => {
              setFilter(event.target.value as TransactionFilter);
            }}
          />
        </div>
      </Card>
      {scope.fleetId === undefined ? (
        <EmptyState title="Indique una flota para ver su historial" />
      ) : null}
      {loading && data === undefined ? <LoadingState /> : null}
      {error === undefined ? null : (
        <ErrorState error={toUiError(error)} onRetry={() => void refetch()} />
      )}
      {data === undefined ? null : (
        <>
          <div className="kpi-grid">
            <KpiCard
              label="Saldo actual"
              value={formatMoney(
                data.walletBalance.balance.amountMinor,
                data.walletBalance.balance.currency,
              )}
              tone="info"
            />
            <KpiCard
              label="Operaciones con incidencias"
              value={problematicSagas(data.sagas).length}
              tone="warning"
            />
          </div>
          <Card title="Movimientos">
            <DataTable
              caption="Movimientos de la billetera"
              rows={filterTransactions(data.transactions.items, filter)}
              rowKey={(t) => t.transactionId}
              empty="No hay movimientos para este filtro"
              columns={[
                { header: 'Fecha', cell: (t) => formatDateTime(t.occurredAt) },
                { header: 'Tipo', cell: (t) => <StatusBadge status={t.type} /> },
                {
                  header: 'Monto',
                  align: 'end',
                  cell: (t) =>
                    `${t.type === 'DEBIT' ? '−' : '+'}${formatMoney(t.amount.amountMinor, t.amount.currency)}`,
                },
                {
                  header: 'Saldo después',
                  align: 'end',
                  cell: (t) => formatMoney(t.balanceAfter.amountMinor, t.balanceAfter.currency),
                },
                {
                  header: 'SAGA',
                  cell: (t) =>
                    t.sagaId === null ? (
                      '—'
                    ) : (
                      <Link to={`/observability?saga=${t.sagaId}`} title={t.sagaId}>
                        {shortId(t.sagaId)}
                      </Link>
                    ),
                },
                {
                  header: 'correlation_id',
                  cell: (t) => <code title={t.correlationId}>{t.correlationId.slice(0, 8)}…</code>,
                },
              ]}
            />
            {data.transactions.pageInfo.hasNextPage ? (
              <Button variant="secondary" onClick={loadMore}>
                Cargar más
              </Button>
            ) : null}
          </Card>
          <Card title="Errores y compensaciones">
            <DataTable
              caption="Operaciones con error o compensación"
              rows={problematicSagas(data.sagas)}
              rowKey={(s) => s.sagaId}
              empty="No hay operaciones con errores ni compensaciones"
              columns={[
                { header: 'Fecha', cell: (s) => formatDateTime(s.createdAt) },
                { header: 'Estado', cell: (s) => <StatusBadge status={s.status} /> },
                { header: 'Motivo', cell: (s) => failureText(s.failureReason) },
                { header: 'Compensaciones', cell: (s) => s.compensationPlan.join(' → ') || '—' },
                {
                  header: 'SAGA',
                  cell: (s) => (
                    <Link to={`/observability?saga=${s.sagaId}`} title={s.sagaId}>
                      {shortId(s.sagaId)}
                    </Link>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
