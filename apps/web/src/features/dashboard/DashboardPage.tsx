import { useState } from 'react';

import { toUiError } from '../../shared/api/errors.ts';
import { useRuntimeConfig } from '../../shared/config/runtime-config-context.ts';
import { formatDateTime, formatKwh } from '../../shared/format/format.ts';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  KpiCard,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
} from '../../shared/ui/components.tsx';
import { summarizeConnectors, type Station } from '../stations/model.ts';
import { useActiveSessions, useDashboard } from './api.ts';
import { HEALTH_LABEL, systemHealth } from './model.ts';

function ActiveSessionsRow({ station }: { station: Station }) {
  const { sessions, loading } = useActiveSessions(station.stationId);
  if (loading && sessions === undefined) {
    return <span className="muted">Cargando…</span>;
  }
  if (sessions === undefined || sessions.length === 0) {
    return <span className="muted">Sin sesiones activas</span>;
  }
  return (
    <ul className="inline-list">
      {sessions.map((s) => (
        <li key={s.sessionId}>
          {s.connectorId}: {formatKwh(s.energyDeliveredKwh ?? 0)} /{' '}
          {formatKwh(s.requestedEnergyKwh)}
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage() {
  const { cities, pollingIntervalMs } = useRuntimeConfig();
  const [city, setCity] = useState(cities[0] ?? 'bogota');
  const { data, loading, error, refetch } = useDashboard(city);

  const summary = summarizeConnectors(data?.stations ?? []);
  const health =
    data === undefined
      ? undefined
      : systemHealth(data.systemStatus.services, data.featureFlags.degraded);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Estado de la red y del sistema. Se actualiza cada ${String(pollingIntervalMs / 1000)} s (polling).`}
        actions={
          <SelectField
            label="Ciudad"
            value={city}
            options={cities.map((c) => ({ value: c, label: c }))}
            onChange={(event) => {
              setCity(event.target.value);
            }}
          />
        }
      />
      {loading && data === undefined ? <LoadingState /> : null}
      {error === undefined ? null : (
        <ErrorState error={toUiError(error)} onRetry={() => void refetch()} />
      )}
      {data === undefined ? null : (
        <>
          <div className="kpi-grid" aria-label="Indicadores">
            <KpiCard label="Estaciones" value={data.stations.length} />
            <KpiCard
              label="Conectores disponibles"
              value={summary.available}
              tone="success"
              hint={`de ${String(summary.total)}`}
            />
            <KpiCard label="Reservados" value={summary.reserved} tone="warning" />
            <KpiCard label="Ocupados (cargando)" value={summary.occupied} tone="info" />
            <KpiCard
              label="Estado del sistema"
              value={health === undefined ? '—' : HEALTH_LABEL[health].label}
              tone={health === undefined ? 'neutral' : HEALTH_LABEL[health].tone}
            />
          </div>
          <div className="grid-2">
            <Card title="Sesiones activas por estación">
              <DataTable
                caption="Sesiones activas por estación"
                rows={data.stations}
                rowKey={(s) => s.stationId}
                empty={`No hay estaciones registradas en ${city}`}
                columns={[
                  { header: 'Estación', cell: (s) => s.name },
                  { header: 'Sesiones activas', cell: (s) => <ActiveSessionsRow station={s} /> },
                ]}
              />
            </Card>
            <Card
              title="Servicios"
              actions={<span className="muted">{formatDateTime(data.systemStatus.checkedAt)}</span>}
            >
              <DataTable
                caption="Disponibilidad de los servicios"
                rows={data.systemStatus.services}
                rowKey={(s) => s.service}
                empty="Sin datos de servicios"
                columns={[
                  { header: 'Servicio', cell: (s) => s.service },
                  {
                    header: 'Estado',
                    cell: (s) => (
                      <Badge tone={s.ready ? 'success' : 'danger'}>
                        {s.ready ? 'Listo' : 'No disponible'}
                      </Badge>
                    ),
                  },
                  { header: 'Latencia', cell: (s) => `${String(s.latencyMs)} ms`, align: 'end' },
                ]}
              />
              <p className="muted">
                Flags activas:{' '}
                {data.featureFlags.flags
                  .filter((f) => f.enabled)
                  .map((f) => f.key)
                  .join(', ') || 'ninguna'}
                {data.featureFlags.degraded
                  ? ' · (valores de respaldo: la tabla de flags no respondió)'
                  : ''}
              </p>
            </Card>
          </div>
          <Card title="Conectores por estación">
            <DataTable
              caption="Conectores por estación"
              rows={data.stations.flatMap((s) =>
                s.connectors.map((c) => ({ station: s, connector: c })),
              )}
              rowKey={(r) => `${r.station.stationId}#${r.connector.connectorId}`}
              empty="Sin conectores"
              columns={[
                { header: 'Estación', cell: (r) => r.station.name },
                { header: 'Conector', cell: (r) => r.connector.connectorId },
                {
                  header: 'Potencia',
                  cell: (r) => `${String(r.connector.maxPowerKw)} kW`,
                  align: 'end',
                },
                { header: 'Estado', cell: (r) => <StatusBadge status={r.connector.status} /> },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
