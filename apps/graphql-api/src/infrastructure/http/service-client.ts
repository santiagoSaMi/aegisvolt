import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { HTTP_HEADERS, problemDetailsSchema } from '@aegisvolt/contracts';
import { getLogContext } from '@aegisvolt/logger';
import type { z } from 'zod';

import { UpstreamRejectedError, UpstreamUnavailableError } from '../../application/index.ts';

export interface ServiceClientOptions {
  /** Nombre del servicio (para errores y logs). */
  readonly service: string;
  readonly baseUrl: string;
  /** Timeout por intento. */
  readonly timeoutMs: number;
  /** Reintentos adicionales SOLO para operaciones idempotentes y fallos transitorios. */
  readonly maxRetries: number;
  readonly retryDelayMs?: number;
  readonly fetch?: typeof fetch;
}

export interface CallOptions<TSchema extends z.ZodType> {
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly schema: TSchema;
  /**
   * ¿Se puede repetir sin efectos duplicados? (GET, PUT con id, comandos con
   * clave idempotente o con resultado ALREADY_*). Solo entonces se reintenta.
   */
  readonly idempotent: boolean;
  /** Timeout propio (p. ej. iniciar la SAGA espera más que una consulta). */
  readonly timeoutMs?: number;
}

/** Fallos en los que NO hay respuesta del servicio o el servicio pide reintentar. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Cliente HTTP interno del BFF hacia un servicio:
 * - propaga `x-correlation-id` desde el contexto de la petición (AsyncLocalStorage);
 * - timeout por intento (AbortSignal);
 * - reintentos SELECTIVOS: solo operaciones idempotentes, solo ante red, timeout
 *   o 502/503/504, con un máximo pequeño y espera con jitter. Nunca ante 4xx ni 500
 *   (un 500 puede venir de un efecto ya aplicado o de un error determinista);
 * - valida la respuesta con el esquema del contrato.
 * No hay *circuit breaker* (ADR-0026): los timeouts cortos y el máximo de
 * reintentos ya acotan el impacto de un servicio caído en este volumen.
 */
export class ServiceClient {
  private readonly options: ServiceClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ServiceClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call<TSchema extends z.ZodType>(call: CallOptions<TSchema>): Promise<z.output<TSchema>> {
    const attempts = call.idempotent ? this.options.maxRetries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once(call);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RetryableFailure) || attempt === attempts) {
          break;
        }
        const base = this.options.retryDelayMs ?? 100;
        await delay(base * attempt + Math.floor(Math.random() * base));
      }
    }
    if (lastError instanceof RetryableFailure) {
      throw new UpstreamUnavailableError(this.options.service, lastError.message, {
        cause: lastError,
      });
    }
    throw lastError;
  }

  private async once<TSchema extends z.ZodType>(
    call: CallOptions<TSchema>,
  ): Promise<z.output<TSchema>> {
    const url = new URL(call.path, this.options.baseUrl);
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    const correlationId = getLogContext()?.correlationId ?? randomUUID();
    const headers: Record<string, string> = {
      accept: 'application/json',
      [HTTP_HEADERS.correlationId]: correlationId,
      ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...call.headers,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: call.method,
        headers,
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        signal: AbortSignal.timeout(call.timeoutMs ?? this.options.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'sin conexión';
      throw new RetryableFailure(
        `${this.options.service}: ${reason} (${call.method} ${call.path})`,
        {
          cause: error,
        },
      );
    }

    const payload = await response.json().catch(() => undefined as unknown);
    if (response.ok) {
      const parsed = call.schema.safeParse(payload);
      if (!parsed.success) {
        throw new UpstreamUnavailableError(
          this.options.service,
          `${this.options.service}: respuesta fuera de contrato (${call.method} ${call.path})`,
        );
      }
      return parsed.data;
    }
    if (RETRYABLE_STATUSES.has(response.status)) {
      throw new RetryableFailure(`${this.options.service}: HTTP ${String(response.status)}`);
    }
    if (response.status >= 500) {
      throw new UpstreamUnavailableError(
        this.options.service,
        `${this.options.service}: HTTP ${String(response.status)}`,
      );
    }
    const problem = problemDetailsSchema.safeParse(payload);
    throw new UpstreamRejectedError({
      service: this.options.service,
      status: response.status,
      upstreamCode: problem.success ? problem.data.code : `HTTP_${String(response.status)}`,
      ...(problem.success && problem.data.detail !== undefined
        ? { detail: problem.data.detail }
        : {}),
    });
  }
}

/** Fallo transitorio interno (se convierte en `UpstreamUnavailableError` al agotar intentos). */
class RetryableFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableFailure';
  }
}
