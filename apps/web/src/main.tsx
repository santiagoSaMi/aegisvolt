import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.tsx';
import { loadRuntimeConfig } from './config/runtime-config.ts';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('No se encontró el elemento #root');
}
const root = createRoot(container);

// La configuración del ambiente la sirve el despliegue (config.json), no el bundle.
loadRuntimeConfig().then(
  (config) => {
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  },
  (error: unknown) => {
    root.render(
      <main className="fatal" role="alert">
        <h1>No se pudo iniciar la consola</h1>
        <p>Error de configuración: {error instanceof Error ? error.message : String(error)}</p>
      </main>,
    );
  },
);
