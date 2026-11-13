/**
 * Configuración que el SPA lee en tiempo de ejecución desde `config.json`.
 * Cada ambiente sirve su propio archivo: la misma imagen se promueve
 * de dev a test y prod sin recompilar (ADR-0017).
 */
export const RUNTIME_ENVIRONMENTS = ['local', 'dev', 'test', 'prod'] as const;
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly graphqlUrl: string;
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  return typeof value === 'string' && (RUNTIME_ENVIRONMENTS as readonly string[]).includes(value);
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (typeof value !== 'object' || value === null) {
    throw new RuntimeConfigError('config.json debe ser un objeto JSON');
  }
  const candidate = value as Record<string, unknown>;
  const environment = candidate.environment;
  const graphqlUrl = candidate.graphqlUrl;

  if (!isRuntimeEnvironment(environment)) {
    throw new RuntimeConfigError(
      `environment inválido; se esperaba uno de: ${RUNTIME_ENVIRONMENTS.join(', ')}`,
    );
  }
  if (typeof graphqlUrl !== 'string' || graphqlUrl.trim() === '') {
    throw new RuntimeConfigError('graphqlUrl es obligatorio');
  }
  return { environment, graphqlUrl };
}

export async function loadRuntimeConfig(fetchFn: typeof fetch = fetch): Promise<RuntimeConfig> {
  const response = await fetchFn('./config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new RuntimeConfigError(`No se pudo cargar config.json (HTTP ${response.status})`);
  }
  return parseRuntimeConfig(await response.json());
}
