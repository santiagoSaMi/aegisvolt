import { z } from 'zod';

/**
 * Configuración que el SPA lee en tiempo de ejecución desde `config.json`, que
 * sirve el DESPLIEGUE de cada ambiente (ConfigMap del overlay en Kubernetes; en
 * desarrollo, el servidor de Vite). La misma imagen se promueve de dev a test y
 * prod sin recompilar (ADR-0017). No contiene secretos: el `clientId` de un app
 * client público de Cognito no lo es. El usuario no puede cambiar el ambiente:
 * no hay selector, y el ambiente efectivo lo informa el backend.
 */
export const RUNTIME_ENVIRONMENTS = ['local', 'dev', 'test', 'prod'] as const;
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

const runtimeConfigSchema = z.object({
  environment: z.enum(RUNTIME_ENVIRONMENTS),
  /** Ruta relativa del mismo origen (sin CORS). */
  graphqlUrl: z.string().trim().min(1),
  auth: z.object({
    /** Ruta del mismo origen que el despliegue reenvía a Cognito (`cognito-idp`). */
    cognitoUrl: z.string().trim().min(1),
    /** App client público del User Pool del ambiente (sin secreto). */
    clientId: z.string().trim().min(1),
  }),
  /** Intervalo de polling de disponibilidad, SAGA y flags (ADR-0017). */
  pollingIntervalMs: z.number().int().min(1_000).max(60_000).default(5_000),
  /** Ciudades del catálogo que muestra la consola. */
  cities: z
    .array(z.string().regex(/^[a-z]+(-[a-z]+)*$/))
    .min(1)
    .default(['bogota']),
});

export type RuntimeConfig = z.output<typeof runtimeConfigSchema>;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (typeof value !== 'object' || value === null) {
    throw new RuntimeConfigError('config.json debe ser un objeto JSON');
  }
  const result = runtimeConfigSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RuntimeConfigError(
      `config.json inválido: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    );
  }
  return result.data;
}

export async function loadRuntimeConfig(fetchFn: typeof fetch = fetch): Promise<RuntimeConfig> {
  const response = await fetchFn('./config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new RuntimeConfigError(`No se pudo cargar config.json (HTTP ${String(response.status)})`);
  }
  return parseRuntimeConfig(await response.json());
}
