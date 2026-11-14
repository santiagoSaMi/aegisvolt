import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Solo en `vite dev`: sirve /config.json con valores del entorno local (p. ej. el
 * clientId del User Pool que crea el bootstrap de Floci). Así nada de esto entra
 * al bundle ni a Git; en los despliegues lo sirve el ConfigMap (ADR-0017).
 */
function devRuntimeConfig(env: Record<string, string>): Plugin {
  return {
    name: 'aegisvolt-dev-runtime-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(
          JSON.stringify({
            environment: env.DEV_APP_ENV ?? 'local',
            graphqlUrl: './graphql',
            auth: {
              cognitoUrl: './auth/cognito',
              clientId: env.DEV_COGNITO_CLIENT_ID ?? 'set-DEV_COGNITO_CLIENT_ID',
            },
            pollingIntervalMs: Number(env.DEV_POLLING_INTERVAL_MS ?? '5000'),
            cities: (env.DEV_CITIES ?? 'bogota').split(','),
          }),
        );
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Prefijo '' para leer variables sin exponerlas al bundle (solo se usan aquí).
  const env = loadEnv(mode, import.meta.dirname, '');
  const graphqlProxyTarget = env.DEV_GRAPHQL_PROXY_TARGET ?? 'http://localhost:4000';
  const cognitoProxyTarget = env.DEV_COGNITO_PROXY_TARGET ?? 'http://localhost:4566';

  return {
    plugins: [react(), devRuntimeConfig(env)],
    // Rutas relativas: la SPA se sirve detrás del prefijo de stage de API Gateway (ADR-0017).
    base: './',
    server: {
      port: 5173,
      // Mismo origen en desarrollo: sin CORS y sin URLs absolutas en el navegador.
      proxy: {
        '/graphql': { target: graphqlProxyTarget, changeOrigin: true },
        '/auth/cognito': {
          target: cognitoProxyTarget,
          changeOrigin: true,
          rewrite: () => '/',
        },
      },
    },
    test: {
      environment: 'jsdom',
      // document.hidden = false: el polling (que se omite con la pestaña oculta) funciona en pruebas.
      environmentOptions: { jsdom: { pretendToBeVisual: true } },
      setupFiles: ['./test/setup.ts'],
      css: false,
    },
  };
});
