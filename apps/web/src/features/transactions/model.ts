import type { SagaSummary, Transaction } from './api.ts';

export type TransactionFilter = 'ALL' | Transaction['type'];

export function filterTransactions(
  items: readonly Transaction[],
  filter: TransactionFilter,
): Transaction[] {
  return filter === 'ALL' ? [...items] : items.filter((t) => t.type === filter);
}

const PROBLEM_STATUSES = new Set(['COMPENSATED', 'FAILED', 'COMPENSATION_FAILED', 'COMPENSATING']);

/** Operaciones con error o compensación (para el historial de incidencias). */
export function problematicSagas(sagas: readonly SagaSummary[]): SagaSummary[] {
  return sagas.filter((s) => PROBLEM_STATUSES.has(s.status));
}
