import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  FEATURE_FLAGS_QUERY,
  UPDATE_FEATURE_FLAG_MUTATION,
} from '../../src/features/feature-flags/api.ts';
import { FeatureFlagsPage } from '../../src/features/feature-flags/FeatureFlagsPage.tsx';
import { admin, operator } from '../support/fixtures.ts';
import { renderPage } from '../support/render.tsx';

function flag(key: string, enabled: boolean, version: number) {
  return {
    __typename: 'FeatureFlag',
    key,
    enabled,
    description: `Descripción de ${key}`,
    source: 'STORE',
    version,
    updatedAt: '2026-11-13T10:00:00.000Z',
    updatedBy: 'cli:admin',
  };
}

function flagsMock(state: { fault: boolean; version: number }) {
  return {
    request: { query: FEATURE_FLAGS_QUERY, variables: {} },
    maxUsageCount: Number.POSITIVE_INFINITY,
    result: () => ({
      data: {
        featureFlags: {
          __typename: 'FeatureFlags',
          environment: 'dev',
          degraded: false,
          readAt: '2026-11-13T10:00:00.000Z',
          flags: [
            flag('ENABLE_DYNAMIC_SURGE_PRICING', false, 1),
            flag('ENABLE_FAST_CHARGE_BOOST', false, 1),
            flag('SIMULATE_CHARGER_HARDWARE_FAULT', state.fault, state.version),
          ],
        },
      },
    }),
  };
}

describe('Feature flags (integración con GraphQL simulado)', () => {
  it('un administrador cambia una flag tras confirmar, con concurrencia optimista y auditoría', async () => {
    const state = { fault: false, version: 3 };
    const sent: unknown[] = [];
    renderPage(<FeatureFlagsPage />, {
      viewer: admin,
      mocks: [
        flagsMock(state),
        {
          request: { query: UPDATE_FEATURE_FLAG_MUTATION, variables: () => true },
          result: (variables: { input: { key: string; enabled: boolean } }) => {
            sent.push(variables.input);
            state.fault = variables.input.enabled;
            state.version++;
            return {
              data: {
                updateFeatureFlag: {
                  __typename: 'UpdateFeatureFlagPayload',
                  changed: true,
                  flag: flag('SIMULATE_CHARGER_HARDWARE_FAULT', state.fault, state.version),
                  change: {
                    __typename: 'FeatureFlagChange',
                    from: false,
                    to: true,
                    changedBy: 'sub-admin',
                    changedAt: '2026-11-13T10:01:00.000Z',
                    correlationId: 'corr-flag-1',
                    environment: 'dev',
                  },
                },
              },
            };
          },
        },
      ],
    });

    const toggle = await screen.findByRole('switch', {
      name: 'SIMULATE_CHARGER_HARDWARE_FAULT: activar',
    });
    expect(screen.getByText('Ambiente: dev')).toBeInTheDocument();

    await userEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Confirmar cambio de flag' });
    expect(dialog).toHaveTextContent('activar SIMULATE_CHARGER_HARDWARE_FAULT en el ambiente dev');
    expect(sent).toHaveLength(0); // nada se envía sin confirmar

    await userEvent.click(screen.getByRole('button', { name: 'Activar' }));
    expect(
      await screen.findByText('Flag SIMULATE_CHARGER_HARDWARE_FAULT actualizada'),
    ).toBeInTheDocument();
    expect(screen.getByText('corr-flag-1')).toBeInTheDocument();
    expect(sent).toEqual([
      { key: 'SIMULATE_CHARGER_HARDWARE_FAULT', enabled: true, expectedVersion: 3 },
    ]);
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'SIMULATE_CHARGER_HARDWARE_FAULT: desactivar' }),
      ).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('cancelar la confirmación no cambia nada', async () => {
    renderPage(<FeatureFlagsPage />, {
      viewer: admin,
      mocks: [flagsMock({ fault: false, version: 1 })],
    });
    await userEvent.click(
      await screen.findByRole('switch', { name: 'ENABLE_FAST_CHARGE_BOOST: activar' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'ENABLE_FAST_CHARGE_BOOST: activar' }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('un conflicto de versión (otro administrador la cambió) se informa', async () => {
    renderPage(<FeatureFlagsPage />, {
      viewer: admin,
      mocks: [
        flagsMock({ fault: false, version: 1 }),
        {
          request: { query: UPDATE_FEATURE_FLAG_MUTATION, variables: () => true },
          result: {
            errors: [
              {
                message: 'La flag cambió; recargue e intente de nuevo',
                extensions: { code: 'CONFLICT', correlationId: 'corr-c' },
              },
            ],
          },
        },
      ],
    });
    await userEvent.click(
      await screen.findByRole('switch', { name: 'SIMULATE_CHARGER_HARDWARE_FAULT: activar' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Activar' }));
    expect(
      await screen.findByText('La flag cambió; recargue e intente de nuevo'),
    ).toBeInTheDocument();
  });

  it('un operador solo ve el estado (sin controles de edición)', async () => {
    renderPage(<FeatureFlagsPage />, {
      viewer: operator,
      mocks: [flagsMock({ fault: true, version: 2 })],
    });
    expect(await screen.findByText('SIMULATE_CHARGER_HARDWARE_FAULT')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Solo un administrador de plataforma puede modificarlas/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Activa')).toHaveLength(1);
  });
});
