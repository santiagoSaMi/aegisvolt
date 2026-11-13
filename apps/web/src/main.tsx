import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { loadRuntimeConfig } from './config/runtime-config.ts';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('No se encontró el elemento #root');
}
const root = createRoot(container);

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
      <p role="alert">
        Error de configuración: {error instanceof Error ? error.message : String(error)}
      </p>,
    );
  },
);
