import { HTTP_HEADERS, problemDetailsSchema } from '@aegisvolt/contracts';
import type { z } from 'zod';

import type { CallContext, CallOutcome } from '../../application/index.ts';

export interface ServiceHttpClientOptions {
  /** URL base del servicio (p. ej. `http://station-reservation:4101`). */
  readonly baseUrl: string;
  /** Timeout por llamada; vencido, el resultado es desconocido (TRANSIENT). */
  readonly timeoutMs: number;
  /** `fetch` inyectable (pruebas). */
  readonly fetch?: typeof fetch;
}

/** Status HTTP que indican que el servicio no pudo atender (reintentables). */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Cliente HTTP genérico hacia un servicio participante:
 * - propaga `x-correlation-id`, `x-saga-id` e `idempotency-key` en CADA llamada;
 * - aplica un timeout por llamada (AbortSignal);
 * - valida la respuesta 2xx con el esquema del contrato;
 * - clasifica: 2xx → OK · 4xx (salvo 408/425/429) → REJECTED con el `code`
 *   del problem+json · 5xx, 408, 429, red o timeout → TRANSIENT.
 */
export class ServiceHttpClient {
  private readonly options: ServiceHttpClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ServiceHttpClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call<TSchema extends z.ZodType>(input: {
    method: 'GET' | 'PUT' | 'POST';
    path: string;
    body?: unknown;
    ctx: CallContext;
    schema: TSchema;
  }): Promise<CallOutcome<z.output<TSchema>>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      [HTTP_HEADERS.correlationId]: input.ctx.correlationId,
      [HTTP_HEADERS.sagaId]: input.ctx.sagaId,
    };
    // `idempotency-key` debe ser un UUID; los pasos con id de recurso ya son idempotentes por id.
    if (UUID.test(input.ctx.idempotencyKey)) {
      headers[HTTP_HEADERS.idempotencyKey] = input.ctx.idempotencyKey;
    }
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(input.path, this.options.baseUrl), {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return name === 'TimeoutError' || name === 'AbortError'
        ? { kind: 'TRANSIENT', code: 'TIMEOUT', detail: `${input.method} ${input.path}` }
        : { kind: 'TRANSIENT', code: 'NETWORK_ERROR', detail: describe(error) };
    }

    const payload = await response.json().catch(() => undefined as unknown);
    if (response.ok) {
      const parsed = input.schema.safeParse(payload);
      return parsed.success
        ? { kind: 'OK', value: parsed.data }
        : {
            kind: 'REJECTED',
            code: 'UNEXPECTED_RESPONSE',
            detail: 'La respuesta no cumple el contrato',
          };
    }
    const problem = problemDetailsSchema.safeParse(payload);
    const code = problem.success ? problem.data.code : `HTTP_${response.status}`;
    const detail = problem.success ? problem.data.detail : undefined;
    const outcome = TRANSIENT_STATUSES.has(response.status) ? 'TRANSIENT' : 'REJECTED';
    return { kind: outcome, code, ...(detail === undefined ? {} : { detail }) };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    return typeof cause === 'string' ? `${error.message} (${cause})` : error.message;
  }
  return String(error);
}
