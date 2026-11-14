import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EnvironmentIndicator } from '../../src/app/EnvironmentIndicator.tsx';
import { RuntimeConfigProvider } from '../../src/shared/config/RuntimeConfigProvider.tsx';
import { operator, testConfig } from '../support/fixtures.ts';

describe('EnvironmentIndicator', () => {
  it('muestra el ambiente que informa el backend, sin selector', () => {
    render(
      <RuntimeConfigProvider config={{ ...testConfig, environment: 'prod' }}>
        <EnvironmentIndicator viewer={{ ...operator, environment: 'prod' }} />
      </RuntimeConfigProvider>,
    );
    expect(screen.getByTestId('environment-badge')).toHaveTextContent('Ambiente: PRODUCCIÓN');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('advierte si config.json y el backend no coinciden (y muestra el del backend)', () => {
    render(
      <RuntimeConfigProvider config={{ ...testConfig, environment: 'dev' }}>
        <EnvironmentIndicator viewer={{ ...operator, environment: 'prod' }} />
      </RuntimeConfigProvider>,
    );
    expect(screen.getByTestId('environment-badge')).toHaveTextContent('PRODUCCIÓN');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'el frontend es de dev y el backend de prod',
    );
  });
});
