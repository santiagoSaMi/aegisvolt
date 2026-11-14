import { ApolloProvider } from '@apollo/client/react';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';

import type { RuntimeConfig } from '../config/runtime-config.ts';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { createApolloClient } from '../shared/api/apollo-client.ts';
import { useAuth } from '../shared/auth/auth-context.ts';
import { AuthProvider } from '../shared/auth/AuthProvider.tsx';
import { createCognitoClient, type CognitoClient } from '../shared/auth/cognito-client.ts';
import { RuntimeConfigProvider } from '../shared/config/RuntimeConfigProvider.tsx';
import { LoadingState } from '../shared/ui/components.tsx';
import { AppShell } from './AppShell.tsx';

// Cada sección se carga bajo demanda (bundle inicial más pequeño).
const DashboardPage = lazy(async () => ({
  default: (await import('../features/dashboard/DashboardPage.tsx')).DashboardPage,
}));
const StationsPage = lazy(async () => ({
  default: (await import('../features/stations/StationsPage.tsx')).StationsPage,
}));
const StationDetailPage = lazy(async () => ({
  default: (await import('../features/stations/StationsPage.tsx')).StationDetailPage,
}));
const ChargingPage = lazy(async () => ({
  default: (await import('../features/charging/ChargingPage.tsx')).ChargingPage,
}));
const TransactionsPage = lazy(async () => ({
  default: (await import('../features/transactions/TransactionsPage.tsx')).TransactionsPage,
}));
const FeatureFlagsPage = lazy(async () => ({
  default: (await import('../features/feature-flags/FeatureFlagsPage.tsx')).FeatureFlagsPage,
}));
const ObservabilityPage = lazy(async () => ({
  default: (await import('../features/observability/ObservabilityPage.tsx')).ObservabilityPage,
}));

/** Cliente GraphQL ligado a la sesión: se recrea al cambiar de usuario (caché aislada). */
function GraphQLProvider({ graphqlUrl, children }: { graphqlUrl: string; children: ReactNode }) {
  const { session, signOut } = useAuth();
  const token = session?.idToken;
  // Un cliente (y una caché) por sesión: al cambiar de usuario no quedan datos del anterior.
  const client = useMemo(
    () => createApolloClient({ graphqlUrl, getToken: () => token, onUnauthenticated: signOut }),
    [graphqlUrl, signOut, token],
  );
  return <ApolloProvider client={client}>{children}</ApolloProvider>;
}

function RequireSession({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session === undefined ? <Navigate to="/login" replace /> : children;
}

function LoginRoute() {
  const { session } = useAuth();
  return session === undefined ? <LoginPage /> : <Navigate to="/dashboard" replace />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route
          element={
            <RequireSession>
              <AppShell />
            </RequireSession>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/stations" element={<StationsPage />} />
          <Route path="/stations/:stationId" element={<StationDetailPage />} />
          <Route path="/charging" element={<ChargingPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/feature-flags" element={<FeatureFlagsPage />} />
          <Route path="/observability" element={<ObservabilityPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

/**
 * Raíz de la consola. HashRouter: el SPA se sirve como archivos estáticos detrás
 * de un prefijo variable (ADR-0017) sin reglas de reescritura en el servidor.
 */
export function App({ config, cognito }: { config: RuntimeConfig; cognito?: CognitoClient }) {
  const client = useMemo(
    () =>
      cognito ??
      createCognitoClient({ cognitoUrl: config.auth.cognitoUrl, clientId: config.auth.clientId }),
    [cognito, config.auth.cognitoUrl, config.auth.clientId],
  );
  return (
    <RuntimeConfigProvider config={config}>
      <AuthProvider cognito={client}>
        <GraphQLProvider graphqlUrl={config.graphqlUrl}>
          <HashRouter>
            <AppRoutes />
          </HashRouter>
        </GraphQLProvider>
      </AuthProvider>
    </RuntimeConfigProvider>
  );
}
