import type { RuntimeConfig } from './config/runtime-config.ts';

interface AppProps {
  readonly config: RuntimeConfig;
}

/** Vistas que exige §2.1 de la especificación; se implementan en la fase de frontend. */
const PLANNED_VIEWS = [
  'Estado de electrolineras y conectores',
  'Reservar y activar carga',
  'Feature flags del ambiente',
  'Historial de transacciones y compensaciones',
] as const;

export function App({ config }: AppProps) {
  return (
    <main className="app">
      <header className="app__header">
        <h1>AegisVolt</h1>
        <span className={`env-badge env-badge--${config.environment}`}>{config.environment}</span>
      </header>
      <p>Estructura inicial. Endpoint GraphQL: {config.graphqlUrl}</p>
      <ul>
        {PLANNED_VIEWS.map((view) => (
          <li key={view}>{view}</li>
        ))}
      </ul>
    </main>
  );
}
