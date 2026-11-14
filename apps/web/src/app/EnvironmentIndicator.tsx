import { useRuntimeConfig } from '../shared/config/runtime-config-context.ts';
import type { Viewer } from '../shared/api/viewer.ts';

const LABELS: Record<string, string> = {
  local: 'LOCAL',
  dev: 'DEV',
  test: 'TEST',
  prod: 'PRODUCCIÓN',
};

/**
 * Ambiente SIEMPRE visible. Lo informa el backend (APP_ENV del graphql-api) y se
 * contrasta con `config.json` del despliegue; si no coinciden se advierte. No
 * hay selector: el navegador no puede cambiar de ambiente.
 */
export function EnvironmentIndicator({ viewer }: { viewer: Viewer | undefined }) {
  const config = useRuntimeConfig();
  const environment = viewer?.environment ?? config.environment;
  const mismatch = viewer !== undefined && viewer.environment !== config.environment;
  return (
    <div className="env">
      <span
        className={`env-badge env-badge--${environment}`}
        title="Ambiente del despliegue (no configurable desde el navegador)"
        data-testid="environment-badge"
      >
        Ambiente: {LABELS[environment] ?? environment}
      </span>
      {mismatch ? (
        <span className="env-warning" role="alert">
          Configuración inconsistente: el frontend es de {config.environment} y el backend de{' '}
          {viewer.environment}
        </span>
      ) : null}
    </div>
  );
}
