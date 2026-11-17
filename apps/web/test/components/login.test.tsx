import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { LoginPage } from '../../src/features/auth/LoginPage.tsx';
import { AuthProvider } from '../../src/shared/auth/AuthProvider.tsx';
import { AuthError, type CognitoClient } from '../../src/shared/auth/cognito-client.ts';
import { RuntimeConfigProvider } from '../../src/shared/config/RuntimeConfigProvider.tsx';
import { testConfig } from '../support/fixtures.ts';

function renderLogin(cognito: CognitoClient) {
  render(
    <RuntimeConfigProvider config={testConfig}>
      <AuthProvider cognito={cognito}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<p>Panel</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </RuntimeConfigProvider>,
  );
}

describe('LoginPage', () => {
  it('valida los campos antes de llamar a Cognito', async () => {
    const signIn = vi.fn();
    renderLogin({ signIn });
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(screen.getByText('Ingrese su usuario')).toBeInTheDocument();
    expect(screen.getByText('Ingrese su contraseña')).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('muestra credenciales inválidas sin revelar detalles', async () => {
    renderLogin({
      signIn: () =>
        Promise.reject(new AuthError('INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos')),
    });
    await userEvent.type(screen.getByLabelText('Usuario'), 'ana');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'mala');
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Usuario o contraseña incorrectos');
  });

  it('inicia sesión, guarda la sesión (sin contraseña) y navega al panel', async () => {
    renderLogin({
      signIn: (username) =>
        Promise.resolve({ idToken: 'jwt', expiresAt: Date.now() + 60_000, username }),
    });
    await userEvent.type(screen.getByLabelText('Usuario'), 'ana');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'buena');
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByText('Panel')).toBeInTheDocument();
    const stored = sessionStorage.getItem('aegisvolt.session') ?? '';
    expect(stored).toContain('jwt');
    expect(stored).not.toContain('buena');
  });
});
