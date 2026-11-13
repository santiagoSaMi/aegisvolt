import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Prefijo '' para leer variables sin exponerlas al bundle (solo se usan aquí).
  const env = loadEnv(mode, import.meta.dirname, '');
  const graphqlProxyTarget = env.DEV_GRAPHQL_PROXY_TARGET ?? 'http://localhost:4000';

  return {
    plugins: [react()],
    // Rutas relativas: la SPA se sirve detrás del prefijo de stage de API Gateway (ADR-0017).
    base: './',
    server: {
      port: 5173,
      // Mismo origen en desarrollo: /graphql se reenvía al GraphQL API local.
      proxy: { '/graphql': { target: graphqlProxyTarget, changeOrigin: true } },
    },
    test: {
      environment: 'node',
    },
  };
});
