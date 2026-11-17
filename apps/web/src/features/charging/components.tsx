import { formatMoney } from '../../shared/format/format.ts';
import {
  Alert,
  Card,
  ErrorState,
  LoadingState,
  StatusBadge,
  Timeline,
} from '../../shared/ui/components.tsx';
import { toUiError } from '../../shared/api/errors.ts';
import { useSagaTracking } from './api.ts';
import { sagaOutcome, sagaTimeline, type ChargingEstimate, type Saga } from './model.ts';

/** Estimación calculada por billing (tarifa, recargo y saldo). */
export function EstimateCard({
  estimate,
  loading,
  error,
}: {
  estimate: ChargingEstimate | undefined;
  loading: boolean;
  error: unknown;
}) {
  return (
    <Card title="Monto estimado">
      {loading ? <LoadingState label="Calculando…" /> : null}
      {error === undefined ? null : <ErrorState error={toUiError(error)} />}
      {estimate === undefined ? (
        loading || error !== undefined ? null : (
          <p className="muted">Complete el formulario para ver el monto estimado.</p>
        )
      ) : (
        <dl className="facts" data-testid="estimate">
          <dt>Monto estimado</dt>
          <dd className="facts__strong">
            {formatMoney(estimate.estimated.amountMinor, estimate.estimated.currency)}
          </dd>
          <dt>Tarifa</dt>
          <dd>{formatMoney(estimate.tariffMinorPerKwh, estimate.estimated.currency)} / kWh</dd>
          <dt>Recargo de hora pico</dt>
          <dd>
            {estimate.surgeApplied
              ? `Aplicado (×${String(estimate.surgeMultiplierBasisPoints / 10_000)})`
              : 'No aplicado'}
          </dd>
          <dt>Potencia del conector</dt>
          <dd>{estimate.connectorPowerKw} kW</dd>
          <dt>Saldo disponible</dt>
          <dd>{formatMoney(estimate.available.amountMinor, estimate.available.currency)}</dd>
        </dl>
      )}
      {estimate !== undefined && !estimate.sufficient ? (
        <Alert tone="warning" title="Saldo insuficiente">
          Puede iniciar la operación, pero el cobro será rechazado y la reserva se liberará
          automáticamente.
        </Alert>
      ) : null}
    </Card>
  );
}

/** Progreso y resultado de la SAGA (estado del backend, actualizado por polling). */
export function SagaProgress({ initial }: { initial: Saga }) {
  const { saga, polling, error } = useSagaTracking(initial.sagaId, initial);
  const outcome = sagaOutcome(saga);
  return (
    <Card title="Progreso de la operación" actions={<StatusBadge status={saga.status} />}>
      <div aria-live="polite" data-testid="saga-progress" data-status={saga.status}>
        <Alert tone={outcome.tone} title={outcome.title}>
          {outcome.description}
        </Alert>
        {polling ? <LoadingState label="Consultando el estado…" /> : null}
        <Timeline items={sagaTimeline(saga)} label="Pasos de la SAGA" />
        <dl className="facts facts--compact">
          <dt>SAGA</dt>
          <dd>
            <code>{saga.sagaId}</code>
          </dd>
          <dt>correlation_id</dt>
          <dd>
            <code>{saga.correlationId}</code>
          </dd>
        </dl>
      </div>
      {error === undefined ? null : <ErrorState error={toUiError(error)} />}
    </Card>
  );
}
