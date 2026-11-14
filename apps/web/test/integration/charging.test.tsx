import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  AVAILABLE_CONNECTORS_QUERY,
  CHARGING_ESTIMATE_QUERY,
  RESERVE_AND_ACTIVATE_MUTATION,
  SAGA_STATUS_QUERY,
} from '../../src/features/charging/api.ts';
import { ChargingPage } from '../../src/features/charging/ChargingPage.tsx';
import { STATIONS_QUERY } from '../../src/features/stations/api.ts';
import { admin, connector, estimate, operator, saga, station, step } from '../support/fixtures.ts';
import { renderPage } from '../support/render.tsx';

const ALWAYS = Number.POSITIVE_INFINITY;

function baseMocks(sufficient = true) {
  return [
    {
      request: { query: STATIONS_QUERY, variables: { city: 'bogota' } },
      result: { data: { stations: [station] } },
      maxUsageCount: ALWAYS,
    },
    {
      request: { query: AVAILABLE_CONNECTORS_QUERY, variables: { stationId: 'st_norte' } },
      result: {
        data: {
          availableConnectors: [
            { __typename: 'AvailableConnector', connector: connector('c1', 'AVAILABLE') },
          ],
        },
      },
      maxUsageCount: ALWAYS,
    },
    {
      request: { query: CHARGING_ESTIMATE_QUERY, variables: () => true },
      result: { data: { chargingEstimate: { ...estimate, sufficient } } },
      maxUsageCount: ALWAYS,
    },
  ];
}

async function fillForm() {
  await screen.findByRole('option', { name: 'Estación Norte' });
  await userEvent.selectOptions(screen.getByLabelText('Estación'), 'st_norte');
  await screen.findByRole('option', { name: /c1 · CCS2/ });
  await userEvent.selectOptions(screen.getByLabelText('Conector'), 'c1');
  await userEvent.clear(screen.getByLabelText('Energía solicitada (kWh)'));
  await userEvent.type(screen.getByLabelText('Energía solicitada (kWh)'), '30');
}

describe('Carga: reservar y activar (integración con GraphQL simulado)', () => {
  it('flujo exitoso: estimación, inicio y seguimiento por polling hasta COMPLETED', async () => {
    const sent: Record<string, unknown>[] = [];
    renderPage(<ChargingPage />, {
      viewer: operator,
      mocks: [
        ...baseMocks(),
        {
          request: { query: RESERVE_AND_ACTIVATE_MUTATION, variables: () => true },
          result: (variables: { input: Record<string, unknown> }) => {
            sent.push(variables.input);
            return {
              data: {
                reserveAndActivateCharging: {
                  __typename: 'ReserveAndActivateChargingPayload',
                  finished: false,
                  saga: saga({
                    status: 'RESERVATION_COMPLETED',
                    steps: [step('RESERVATION', 'SUCCEEDED'), step('DEBIT', 'IN_PROGRESS')],
                  }),
                },
              },
            };
          },
        },
        {
          request: { query: SAGA_STATUS_QUERY, variables: { sagaId: 'saga_0001' } },
          result: {
            data: {
              sagaStatus: saga({
                status: 'COMPLETED',
                steps: ['RESERVATION', 'DEBIT', 'ACTIVATION', 'CONFIRMATION'].map((s) =>
                  step(s, 'SUCCEEDED'),
                ),
              }),
            },
          },
          maxUsageCount: ALWAYS,
        },
      ],
    });

    // La flota del operador viene de su identidad y no es editable.
    expect(screen.getByLabelText('Flota')).toHaveAttribute('readonly');
    await fillForm();
    const estimateCard = await screen.findByTestId('estimate');
    expect(estimateCard).toHaveTextContent('30.000,00');

    await userEvent.click(screen.getByRole('button', { name: 'Iniciar carga' }));

    const progress = await screen.findByTestId('saga-progress');
    expect(progress).toHaveAttribute('data-status', 'RESERVATION_COMPLETED');
    expect(progress).toHaveTextContent('Operación en curso');
    await waitFor(
      () => {
        expect(progress).toHaveAttribute('data-status', 'COMPLETED');
      },
      { timeout: 4000 },
    );
    expect(progress).toHaveTextContent('Carga iniciada');
    expect(progress).toHaveTextContent('corr-1234-5678');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      stationId: 'st_norte',
      connectorId: 'c1',
      requestedEnergyKwh: 30,
    });
    expect(sent[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(sent[0]).not.toHaveProperty('fleetId'); // el backend usa la flota del token
  });

  it('flujo fallido: falla del cargador → SAGA compensada (reembolso y liberación)', async () => {
    renderPage(<ChargingPage />, {
      viewer: operator,
      mocks: [
        ...baseMocks(),
        {
          request: { query: RESERVE_AND_ACTIVATE_MUTATION, variables: () => true },
          result: {
            data: {
              reserveAndActivateCharging: {
                __typename: 'ReserveAndActivateChargingPayload',
                finished: true,
                saga: saga({
                  status: 'COMPENSATED',
                  failureReason: 'CHARGER_HARDWARE_FAULT',
                  compensationPlan: ['REFUND_DEBIT', 'RELEASE_RESERVATION'],
                  steps: [
                    step('RESERVATION', 'SUCCEEDED'),
                    step('DEBIT', 'SUCCEEDED'),
                    step('ACTIVATION', 'FAILED', 'CHARGER_HARDWARE_FAULT'),
                    step('REFUND_DEBIT', 'SUCCEEDED'),
                    step('RELEASE_RESERVATION', 'SUCCEEDED'),
                  ],
                }),
              },
            },
          },
        },
      ],
    });

    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar carga' }));

    const progress = await screen.findByTestId('saga-progress');
    expect(progress).toHaveAttribute('data-status', 'COMPENSATED');
    expect(progress).toHaveTextContent('La operación no se completó y se compensó');
    expect(progress).toHaveTextContent('falla de hardware');
    const steps = within(screen.getByRole('list', { name: 'Pasos de la SAGA' }));
    expect(steps.getByText('Compensación: reembolsar el cobro')).toBeInTheDocument();
    expect(steps.getByText('Compensación: liberar el conector')).toBeInTheDocument();
    expect(screen.queryByText('Consultando el estado…')).not.toBeInTheDocument();
  });

  it('error del servicio: se muestra con correlation_id y el reintento reutiliza la clave de idempotencia', async () => {
    const keys: unknown[] = [];
    let calls = 0;
    renderPage(<ChargingPage />, {
      viewer: operator,
      mocks: [
        ...baseMocks(),
        {
          request: { query: RESERVE_AND_ACTIVATE_MUTATION, variables: () => true },
          maxUsageCount: 2,
          result: (variables: { input: Record<string, unknown> }) => {
            keys.push(variables.input.idempotencyKey);
            calls++;
            return calls === 1
              ? {
                  errors: [
                    {
                      message: 'x',
                      extensions: { code: 'SERVICE_UNAVAILABLE', correlationId: 'corr-err-1' },
                    },
                  ],
                }
              : {
                  data: {
                    reserveAndActivateCharging: {
                      __typename: 'ReserveAndActivateChargingPayload',
                      finished: true,
                      saga: saga({ status: 'COMPLETED' }),
                    },
                  },
                };
          },
        },
      ],
    });

    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar carga' }));
    const alert = await screen.findByText(
      'Un servicio no está disponible en este momento. Intente de nuevo.',
    );
    expect(alert.closest('[role="alert"]')).toHaveTextContent('corr-err-1');

    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByTestId('saga-progress')).toHaveAttribute('data-status', 'COMPLETED');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('advierte saldo insuficiente según la estimación del backend', async () => {
    renderPage(<ChargingPage />, { viewer: operator, mocks: baseMocks(false) });
    await fillForm();
    expect(await screen.findByText('Saldo insuficiente')).toBeInTheDocument();
  });

  it('un administrador debe indicar una flota válida antes de iniciar', async () => {
    renderPage(<ChargingPage />, { viewer: admin, mocks: baseMocks() });
    await fillForm();
    const start = screen.getByRole('button', { name: 'Iniciar carga' });
    expect(start).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Flota'), 'Flota Mala');
    expect(screen.getByText('Indique una flota válida (fleet_…)')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Flota'));
    await userEvent.type(screen.getByLabelText('Flota'), 'fleet_alfa');
    expect(start).toBeEnabled();
  });
});
