/**
 * Cabeceras HTTP compartidas por todas las unidades desplegables (ADR-0004, ADR-0009).
 * En minúsculas: Node.js normaliza así los nombres de cabeceras entrantes.
 */
export const HTTP_HEADERS = {
  correlationId: 'x-correlation-id',
  sagaId: 'x-saga-id',
  idempotencyKey: 'idempotency-key',
} as const;

export type HttpHeaderName = (typeof HTTP_HEADERS)[keyof typeof HTTP_HEADERS];
