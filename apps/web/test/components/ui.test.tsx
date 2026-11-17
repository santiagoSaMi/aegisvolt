import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  ConfirmDialog,
  DataTable,
  ErrorState,
  StatusBadge,
  Switch,
  TextField,
} from '../../src/shared/ui/components.tsx';

describe('componentes compartidos', () => {
  it('StatusBadge muestra la etiqueta en español y conserva el estado del backend', () => {
    render(<StatusBadge status="COMPENSATED" />);
    expect(screen.getByText('Compensada')).toHaveAttribute('data-status', 'COMPENSATED');
  });

  it('ErrorState anuncia el error con correlation_id y permite reintentar', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        error={{
          message: 'Servicio no disponible',
          code: 'SERVICE_UNAVAILABLE',
          reason: 'TIMEOUT',
          correlationId: 'corr-9',
        }}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Servicio no disponible');
    expect(alert).toHaveTextContent('corr-9');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('DataTable muestra el estado vacío o las filas con encabezados', () => {
    const columns = [{ header: 'Id', cell: (r: { id: string }) => r.id }];
    const { rerender } = render(
      <DataTable
        caption="Lista"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty="Sin datos"
      />,
    );
    expect(screen.getByText('Sin datos')).toBeInTheDocument();

    rerender(
      <DataTable
        caption="Lista"
        columns={columns}
        rows={[{ id: 'a' }, { id: 'b' }]}
        rowKey={(r) => r.id}
        empty="Sin datos"
      />,
    );
    const table = screen.getByRole('table', { name: 'Lista' });
    expect(within(table).getByRole('columnheader', { name: 'Id' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('TextField asocia etiqueta, ayuda y error (accesible)', () => {
    render(<TextField label="Energía" hint="En kWh" error="Requerido" value="" readOnly />);
    const input = screen.getByLabelText('Energía');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('En kWh Requerido');
  });

  it('Switch expone role=switch y aria-checked', async () => {
    const onChange = vi.fn();
    render(<Switch label="Flag X" checked={false} onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Flag X' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('ConfirmDialog enfoca Cancelar y se cierra con Escape', async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="¿Seguro?"
        confirmLabel="Sí"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      >
        <p>Detalle</p>
      </ConfirmDialog>,
    );
    expect(screen.getByRole('dialog', { name: '¿Seguro?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});
