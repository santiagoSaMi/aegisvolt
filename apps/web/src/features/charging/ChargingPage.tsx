import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { useRuntimeConfig } from '../../shared/config/runtime-config-context.ts';
import { useViewerContext } from '../../shared/hooks/useViewerContext.ts';
import {
  Button,
  Card,
  ErrorState,
  PageHeader,
  SelectField,
  TextField,
} from '../../shared/ui/components.tsx';
import { useStations } from '../stations/api.ts';
import { useAvailableConnectors, useChargingEstimate } from './api.ts';
import { EstimateCard, SagaProgress } from './components.tsx';
import { useChargingForm } from './useChargingForm.ts';
import { useStartCharging } from './useStartCharging.ts';

/** Reservar y activar una carga: formulario, estimación, inicio y seguimiento de la SAGA. */
export function ChargingPage() {
  const viewer = useViewerContext();
  const { cities } = useRuntimeConfig();
  const [city, setCity] = useState(cities[0] ?? 'bogota');
  const form = useChargingForm(viewer);
  const { stations } = useStations(city);
  const { connectors } = useAvailableConnectors(form.values.stationId || undefined);
  const estimate = useChargingEstimate(form.input);
  const operation = useStartCharging();
  const retryInput = form.input;

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    form.touchAll();
    if (form.input !== undefined) {
      void operation.start(form.input);
    }
  };

  return (
    <>
      <PageHeader
        title="Carga"
        description="Reserve un conector, revise el monto estimado e inicie la carga. La operación es una SAGA: si un paso falla, se compensa automáticamente."
      />
      <div className="grid-2">
        <Card title="Nueva operación">
          <form onSubmit={onSubmit} noValidate aria-label="Reservar y activar carga">
            {viewer.isAdmin ? (
              <TextField
                label="Flota"
                name="fleetId"
                placeholder="fleet_…"
                value={form.values.fleetId}
                error={form.errors.fleetId}
                hint="Como administrador, indique la flota a la que se cobrará."
                onChange={(event) => {
                  form.setField('fleetId', event.target.value);
                }}
              />
            ) : (
              <TextField
                label="Flota"
                name="fleetId"
                value={viewer.fleetId ?? ''}
                readOnly
                hint="La flota de su cuenta."
              />
            )}
            <SelectField
              label="Ciudad"
              value={city}
              options={cities.map((c) => ({ value: c, label: c }))}
              onChange={(event) => {
                setCity(event.target.value);
                form.setField('stationId', '');
              }}
            />
            <SelectField
              label="Estación"
              name="stationId"
              value={form.values.stationId}
              placeholder="Seleccione una estación"
              options={(stations ?? []).map((s) => ({ value: s.stationId, label: s.name }))}
              error={form.errors.stationId}
              onChange={(event) => {
                form.setField('stationId', event.target.value);
              }}
            />
            <SelectField
              label="Conector"
              name="connectorId"
              value={form.values.connectorId}
              placeholder={
                form.values.stationId === ''
                  ? 'Primero elija una estación'
                  : 'Seleccione un conector'
              }
              options={(connectors ?? []).map(({ connector }) => ({
                value: connector.connectorId,
                label: `${connector.connectorId} · ${connector.type} · ${String(connector.maxPowerKw)} kW`,
              }))}
              error={form.errors.connectorId}
              hint={
                form.values.stationId !== '' && connectors?.length === 0
                  ? 'No hay conectores disponibles en esta estación ahora.'
                  : 'Solo se listan conectores disponibles.'
              }
              onChange={(event) => {
                form.setField('connectorId', event.target.value);
              }}
            />
            <TextField
              label="Energía solicitada (kWh)"
              name="energyKwh"
              type="number"
              inputMode="decimal"
              min="0.001"
              max="500"
              step="0.001"
              value={form.values.energyKwh}
              error={form.errors.energyKwh}
              onChange={(event) => {
                form.setField('energyKwh', event.target.value);
              }}
            />
            <div className="form-actions">
              <Button
                type="submit"
                loading={operation.starting}
                disabled={form.input === undefined}
              >
                Iniciar carga
              </Button>
              {operation.saga === undefined ? null : (
                <Button variant="secondary" onClick={operation.reset}>
                  Nueva operación
                </Button>
              )}
            </div>
          </form>
          {operation.error === undefined ? null : (
            <ErrorState
              error={operation.error}
              onRetry={
                retryInput === undefined ? undefined : () => void operation.start(retryInput)
              }
            />
          )}
        </Card>
        <EstimateCard
          estimate={form.input === undefined ? undefined : estimate.estimate}
          loading={estimate.loading}
          error={estimate.error}
        />
      </div>
      {operation.saga === undefined ? null : (
        <>
          <SagaProgress key={operation.saga.sagaId} initial={operation.saga} />
          <p>
            <Link to={`/observability?saga=${operation.saga.sagaId}`}>
              Ver el historial completo en Observabilidad →
            </Link>
          </p>
        </>
      )}
    </>
  );
}
