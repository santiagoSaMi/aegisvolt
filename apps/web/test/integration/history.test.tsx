import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FLEET_SAGAS_QUERY, SAGA_HISTORY_QUERY } from '../../src/features/observability/api.ts';
import { ObservabilityPage } from '../../src/features/observability/ObservabilityPage.tsx';
import { TRANSACTIONS_QUERY } from '../../src/features/transactions/api.ts';
import { TransactionsPage } from '../../src/features/transactions/TransactionsPage.tsx';
import { money, operator, saga } from '../support/fixtures.ts';
import { renderPage } from '../support/render.tsx';

const compensated = saga({
  status: 'COMPENSATED',
  sagaId: 'saga_comp',
  correlationId: 'corr-comp-77',
  failureReason: 'CHARGER_HARDWARE_FAULT',
  compensationPlan: ['REFUND_DEBIT', 'RELEASE_RESERVATION'],
});
const completed = saga({ status: 'COMPLETED', sagaId: 'saga_ok', correlationId: 'corr-ok-11' });

function event(
  sequence: number,
  type: string,
  status: string,
  stepName: string | null,
  errorCode: string | null = null,
) {
  return {
    __typename: 'SagaEvent',
    sequence,
    type,
    step: stepName,
    status,
    attempt: stepName === null ? null : 1,
    errorCode,
    occurredAt: '2026-11-13T10:00:00.000Z',
  };
}

describe('Observabilidad', () => {
  it('lista las SAGAs, filtra por correlation_id y muestra el historial con compensaciones', async () => {
    renderPage(<ObservabilityPage />, {
      viewer: operator,
      path: '/observability',
      mocks: [
        {
          request: { query: FLEET_SAGAS_QUERY, variables: { fleetId: 'fleet_alfa', first: 50 } },
          result: { data: { sagas: [compensated, completed] } },
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
        {
          request: { query: SAGA_HISTORY_QUERY, variables: { sagaId: 'saga_comp' } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: {
            data: {
              sagaStatus: {
                ...compensated,
                events: [
                  event(1, 'SAGA_STARTED', 'STARTED', null),
                  event(2, 'STEP_FAILED', 'FAILED', 'ACTIVATION', 'CHARGER_HARDWARE_FAULT'),
                  event(3, 'COMPENSATION_SUCCEEDED', 'SUCCEEDED', 'REFUND_DEBIT'),
                  event(4, 'SAGA_COMPENSATED', 'COMPENSATED', null),
                ],
              },
            },
          },
        },
      ],
    });

    const table = await screen.findByRole('table', { name: 'SAGAs de la flota' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);

    await userEvent.type(screen.getByLabelText('Buscar por sagaId o correlation_id'), 'corr-comp');
    expect(within(table).getAllByRole('row')).toHaveLength(2);

    await userEvent.click(within(table).getByRole('button', { name: 'saga_comp' }));
    expect(await screen.findByTestId('saga-correlation-id')).toHaveTextContent('corr-comp-77');
    const events = within(screen.getByRole('list', { name: 'Eventos de la SAGA' }));
    expect(events.getByText('Paso fallido · ACTIVATION')).toBeInTheDocument();
    expect(events.getByText('Compensación verificada · REFUND_DEBIT')).toBeInTheDocument();
    expect(screen.getByText('REFUND_DEBIT → RELEASE_RESERVATION')).toBeInTheDocument();
  });
});

describe('Historial de transacciones', () => {
  it('muestra débitos y reembolsos y separa las operaciones compensadas', async () => {
    const tx = (transactionId: string, type: string, amountMinor: number, balance: number) => ({
      __typename: 'Transaction',
      transactionId,
      type,
      amount: money(amountMinor),
      balanceAfter: money(balance),
      sagaId: 'saga_comp',
      debitId: 'deb_1',
      correlationId: 'corr-comp-77',
      occurredAt: '2026-11-13T10:00:00.000Z',
    });
    renderPage(<TransactionsPage />, {
      viewer: operator,
      mocks: [
        {
          request: { query: TRANSACTIONS_QUERY, variables: { fleetId: 'fleet_alfa', first: 20 } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: {
            data: {
              walletBalance: {
                __typename: 'Wallet',
                fleetId: 'fleet_alfa',
                balance: money(500_000_00),
              },
              transactions: {
                __typename: 'TransactionConnection',
                items: [
                  tx('tx_2', 'REFUND', 30_000_00, 500_000_00),
                  tx('tx_1', 'DEBIT', 30_000_00, 470_000_00),
                ],
                pageInfo: { __typename: 'PageInfo', endCursor: null, hasNextPage: false },
              },
              sagas: [compensated, completed],
            },
          },
        },
      ],
    });

    const movements = await screen.findByRole('table', { name: 'Movimientos de la billetera' });
    expect(within(movements).getByText('Débito')).toBeInTheDocument();
    expect(within(movements).getByText('Reembolso')).toBeInTheDocument();

    const problems = screen.getByRole('table', { name: 'Operaciones con error o compensación' });
    expect(within(problems).getAllByRole('row')).toHaveLength(2);
    expect(
      within(problems).getByText('El cargador reportó una falla de hardware'),
    ).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Tipo'), 'REFUND');
    expect(
      within(screen.getByRole('table', { name: 'Movimientos de la billetera' })).queryByText(
        'Débito',
      ),
    ).not.toBeInTheDocument();
  });
});
