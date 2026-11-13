/**
 * Contrato público de billing-wallet-service, versión 1.
 * Proveedor: billing-wallet-service. Consumidores: saga-orchestrator-service
 * (débito y reembolso) y graphql-api (billetera, historial y recargas).
 */
import { z } from 'zod';

import {
  debitIdSchema,
  fleetIdSchema,
  sagaIdSchema,
  topUpIdSchema,
  walletTransactionIdSchema,
} from '../common/identifiers.ts';
import {
  compensationReasonSchema,
  energyKwhSchema,
  isoDateTimeSchema,
  moneySchema,
  paginationQuerySchema,
  positiveMoneySchema,
  powerKwSchema,
} from '../common/primitives.ts';
import { COMMON_ERROR_CODES, problemSchemaFor } from '../problem-details.ts';

export const API = {
  name: 'billing-wallet',
  version: '1.0.0',
  basePath: '/v1',
} as const;

export const paths = {
  wallet: (fleetId: string) => `${API.basePath}/wallets/${encodeURIComponent(fleetId)}`,
  walletTransactions: (fleetId: string) =>
    `${API.basePath}/wallets/${encodeURIComponent(fleetId)}/transactions`,
  topUp: (fleetId: string, topUpId: string) =>
    `${API.basePath}/wallets/${encodeURIComponent(fleetId)}/top-ups/${encodeURIComponent(topUpId)}`,
  debit: (debitId: string) => `${API.basePath}/debits/${encodeURIComponent(debitId)}`,
  refundDebit: (debitId: string) => `${API.basePath}/debits/${encodeURIComponent(debitId)}/refund`,
} as const;

// --- Vocabulario público ---------------------------------------------------

export const DEBIT_STATUSES = [
  'DEBITED',
  'REFUNDED',
  'REJECTED_INSUFFICIENT_FUNDS',
  'VOIDED',
] as const;
export const WALLET_TRANSACTION_TYPES = ['DEBIT', 'REFUND', 'TOP_UP'] as const;
export const REFUND_OUTCOMES = [
  'REFUNDED',
  'ALREADY_REFUNDED',
  'NOTHING_TO_REFUND',
  'VOIDED',
] as const;

export const debitStatusSchema = z.enum(DEBIT_STATUSES);
export const walletTransactionTypeSchema = z.enum(WALLET_TRANSACTION_TYPES);

// --- Lecturas ------------------------------------------------------------

/** `GET /v1/wallets/{fleetId}` */
export const walletViewSchema = z.object({
  fleetId: fleetIdSchema,
  balance: moneySchema,
  updatedAt: isoDateTimeSchema,
});

export const walletTransactionViewSchema = z.object({
  transactionId: walletTransactionIdSchema,
  fleetId: fleetIdSchema,
  type: walletTransactionTypeSchema,
  amount: positiveMoneySchema,
  balanceAfter: moneySchema,
  sagaId: sagaIdSchema.optional(),
  debitId: debitIdSchema.optional(),
  topUpId: topUpIdSchema.optional(),
  occurredAt: isoDateTimeSchema,
});

/** `GET /v1/wallets/{fleetId}/transactions?limit=&cursor=` (más reciente primero) */
export const listWalletTransactionsQuerySchema = paginationQuerySchema;
export const listWalletTransactionsResponseSchema = z.object({
  items: z.array(walletTransactionViewSchema),
  nextCursor: z.string().optional(),
});

// --- Comandos ------------------------------------------------------------

export const debitViewSchema = z.object({
  debitId: debitIdSchema,
  sagaId: sagaIdSchema,
  fleetId: fleetIdSchema,
  status: debitStatusSchema,
  amount: moneySchema,
  pricing: z.object({
    tariffMinorPerKwh: z.int().positive(),
    /** Multiplicador en puntos básicos: 10000 = 1×, 12500 = 1,25×. */
    surgeMultiplierBasisPoints: z.int().min(10_000),
    surgeApplied: z.boolean(),
  }),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * `PUT /v1/debits/{debitId}`: cargo del importe estimado (paso 2 de la SAGA).
 * El importe lo calcula el servicio (tarifa × energía × surge), no el cliente.
 * - 201 DEBITED · 200 repetición idéntica.
 * - 422 INSUFFICIENT_FUNDS (definitivo; el rechazo queda registrado y se repite igual).
 * - 409 DEBIT_VOIDED (tombstone) · 409 IDEMPOTENCY_CONFLICT.
 * Cabeceras: `sagaCommandHeadersSchema`.
 */
export const debitRequestSchema = z.strictObject({
  sagaId: sagaIdSchema,
  fleetId: fleetIdSchema,
  energyKwh: energyKwhSchema,
  connectorPowerKw: powerKwSchema,
});
export const debitResponseSchema = debitViewSchema;

/**
 * `POST /v1/debits/{debitId}/refund` (compensación, idempotente):
 * - REFUNDED · ALREADY_REFUNDED · NOTHING_TO_REFUND (el débito fue rechazado)
 * - VOIDED: no existía; tombstone que bloquea un `PUT` tardío.
 */
export const refundDebitRequestSchema = z.strictObject({ reason: compensationReasonSchema });
export const refundDebitResponseSchema = z.object({
  debitId: debitIdSchema,
  status: debitStatusSchema,
  outcome: z.enum(REFUND_OUTCOMES),
});

/**
 * `PUT /v1/wallets/{fleetId}/top-ups/{topUpId}`: recarga (solo `platform-admins`,
 * vía graphql-api). Idempotente por `topUpId`.
 */
export const topUpRequestSchema = z.strictObject({ amount: positiveMoneySchema });
export const topUpResponseSchema = z.object({
  wallet: walletViewSchema,
  transaction: walletTransactionViewSchema,
});

// --- Errores ---------------------------------------------------------------

export const ERROR_CODES = {
  ...COMMON_ERROR_CODES,
  WALLET_NOT_FOUND: 404,
  DEBIT_NOT_FOUND: 404,
  INSUFFICIENT_FUNDS: 422,
  CURRENCY_MISMATCH: 422,
  DEBIT_VOIDED: 409,
  IDEMPOTENCY_CONFLICT: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

// --- Tipos -------------------------------------------------------------------

export type WalletView = z.output<typeof walletViewSchema>;
export type WalletTransactionView = z.output<typeof walletTransactionViewSchema>;
export type DebitView = z.output<typeof debitViewSchema>;
export type DebitRequest = z.output<typeof debitRequestSchema>;
export type RefundDebitRequest = z.output<typeof refundDebitRequestSchema>;
export type RefundDebitResponse = z.output<typeof refundDebitResponseSchema>;
export type TopUpRequest = z.output<typeof topUpRequestSchema>;
