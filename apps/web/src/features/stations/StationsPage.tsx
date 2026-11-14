import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { toUiError } from '../../shared/api/errors.ts';
import { useRuntimeConfig } from '../../shared/config/runtime-config-context.ts';
import { formatDateTime, formatKwh } from '../../shared/format/format.ts';
import {
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  StatusBadge,
} from '../../shared/ui/components.tsx';
import { useStationDetail, useStations } from './api.ts';
import { summarizeConnectors } from './model.ts';

/** Catálogo de estaciones de una ciudad con su disponibilidad. */
export function StationsPage() {
  const { cities } = useRuntimeConfig();
  const [city, setCity] = useState(cities[0] ?? 'bogota');
  const { stations, loading, error, refetch } = useStations(city);

  return (
    <>
      <PageHeader
        title="Estaciones"
        description="Estaciones, conectores y disponibilidad (actualización periódica)."
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
      {loading && stations === undefined ? <LoadingState /> : null}
      {error === undefined ? null : (
        <ErrorState error={toUiError(error)} onRetry={() => void refetch()} />
      )}
      {stations === undefined ? null : (
        <Card title={`Estaciones en ${city}`}>
          <DataTable
            caption={`Estaciones en ${city}`}
            rows={stations}
            rowKey={(s) => s.stationId}
            empty={`No hay estaciones registradas en ${city}`}
            columns={[
              {
                header: 'Estación',
                cell: (s) => <Link to={`/stations/${s.stationId}`}>{s.name}</Link>,
              },
              { header: 'Id', cell: (s) => <code>{s.stationId}</code> },
              {
                header: 'Disponibles',
                align: 'end',
                cell: (s) => {
                  const summary = summarizeConnectors([s]);
                  return `${String(summary.available)} / ${String(summary.total)}`;
                },
              },
              {
                header: 'Reservados',
                align: 'end',
                cell: (s) => summarizeConnectors([s]).reserved,
              },
              { header: 'Ocupados', align: 'end', cell: (s) => summarizeConnectors([s]).occupied },
            ]}
          />
        </Card>
      )}
    </>
  );
}

/** Detalle: conectores y sesiones activas con su última lectura de telemetría. */
export function StationDetailPage() {
  const { stationId = '' } = useParams();
  const { station, sessions, loading, error, refetch } = useStationDetail(stationId);

  if (loading && station === undefined) {
    return <LoadingState />;
  }
  if (error !== undefined) {
    return <ErrorState error={toUiError(error)} onRetry={() => void refetch()} />;
  }
  if (station === null || station === undefined) {
    return (
      <EmptyState title="La estación no existe">
        <Link to="/stations">Volver a estaciones</Link>
      </EmptyState>
    );
  }
  return (
    <>
      <PageHeader
        title={station.name}
        description={`${station.city} · ${station.stationId}`}
        actions={<Link to="/stations">← Estaciones</Link>}
      />
      <Card title="Conectores">
        <DataTable
          caption="Conectores de la estación"
          rows={station.connectors}
          rowKey={(c) => c.connectorId}
          empty="La estación no tiene conectores"
          columns={[
            { header: 'Conector', cell: (c) => c.connectorId },
            { header: 'Tipo', cell: (c) => c.type },
            {
              header: 'Potencia',
              align: 'end',
              cell: (c) => `${String(c.maxPowerKw)} kW${c.ultraFast ? ' · ultra rápido' : ''}`,
            },
            { header: 'Estado', cell: (c) => <StatusBadge status={c.status} /> },
          ]}
        />
      </Card>
      <Card title="Sesiones activas (telemetría por polling)">
        <DataTable
          caption="Sesiones activas"
          rows={sessions}
          rowKey={(s) => s.sessionId}
          empty="No hay cargas en curso en esta estación"
          columns={[
            {
              header: 'Sesión',
              cell: (s) => <code title={s.sessionId}>{s.sessionId.slice(0, 16)}…</code>,
            },
            { header: 'Conector', cell: (s) => s.connectorId },
            {
              header: 'Entregado',
              align: 'end',
              cell: (s) =>
                `${formatKwh(s.energyDeliveredKwh ?? 0)} / ${formatKwh(s.requestedEnergyKwh)}`,
            },
            {
              header: 'Potencia actual',
              align: 'end',
              cell: (s) =>
                s.telemetry[0] === undefined ? '—' : `${String(s.telemetry[0].powerKw)} kW`,
            },
            { header: 'Inicio', cell: (s) => formatDateTime(s.startedAt) },
          ]}
        />
      </Card>
    </>
  );
}
