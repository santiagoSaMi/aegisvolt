import { NavLink, Outlet } from 'react-router';

import { useViewer } from '../shared/api/viewer.ts';
import { useAuth } from '../shared/auth/auth-context.ts';
import { Button, ErrorState, LoadingState } from '../shared/ui/components.tsx';
import { toUiError } from '../shared/api/errors.ts';
import { EnvironmentIndicator } from './EnvironmentIndicator.tsx';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/stations', label: 'Estaciones' },
  { to: '/charging', label: 'Carga' },
  { to: '/transactions', label: 'Transacciones' },
  { to: '/feature-flags', label: 'Feature flags' },
  { to: '/observability', label: 'Observabilidad' },
] as const;

/** Estructura de la consola: cabecera (ambiente, usuario), navegación y contenido. */
export function AppShell() {
  const { session, signOut } = useAuth();
  const { viewer, loading, error } = useViewer();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Saltar al contenido
      </a>
      <header className="shell__header">
        <div className="shell__brand">
          <span className="logo" aria-hidden="true">
            ⚡
          </span>
          <span>AegisVolt · Consola de flotas</span>
        </div>
        <EnvironmentIndicator viewer={viewer} />
        <div className="shell__user">
          {viewer === undefined ? null : (
            <span className="shell__identity">
              {session?.username ?? viewer.subject}
              <small>
                {viewer.isAdmin
                  ? 'Administrador de plataforma'
                  : `Operador · ${viewer.fleetId ?? 'sin flota'}`}
              </small>
            </span>
          )}
          <Button variant="ghost" onClick={signOut}>
            Cerrar sesión
          </Button>
        </div>
      </header>
      <nav className="shell__nav" aria-label="Secciones">
        <ul>
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')}
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="shell__main" tabIndex={-1}>
        {loading && viewer === undefined ? <LoadingState label="Cargando su perfil…" /> : null}
        {error === undefined ? null : <ErrorState error={toUiError(error)} />}
        {viewer === undefined ? null : <Outlet context={viewer} />}
      </main>
    </div>
  );
}
