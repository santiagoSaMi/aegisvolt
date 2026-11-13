/**
 * Contrato público de billing-wallet-service, versión 1.
 * Proveedor: billing-wallet-service. Consumidores: saga-orchestrator-service
 * (débito y reembolso) y graphql-api (billetera, historial y recargas).
 */
import { z } from 'zod';

import {
  correlationIdSchema,
  debitIdSchema,
  fleetIdSchema,
  refundIdSchema,
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
  version: '1.1.0',
  basePath: '/v1',
} as const;

export const paths = {
  wallet: (fleetId: string) => `${API.basePath}/wallets/${encodeURIComponent(fleetId)}`,
  fundsCheck: (fleetId: string) =>
    `${API.basePath}/wallets/${encodeURIComponent(fleetId)}/funds-check`,
  walletTransactions: (fleetId: string) =>
    `${API.basePath}/wallets/${encodeURIComponent(fleetId)}/transactions`,
  topUp: (fleetId: string, topUpId: string) =>
    `${API.basePath}/wallets/${encodeURIComponent(fleetId)}/top-ups/${encodeURIComponent(topUpId)}`,
  debits: () => `${API.basePath}/debits`,
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

const pricingViewSchema = z.object({
  tariffMinorPerKwh: z.int().positive(),
  /** Multiplicador en puntos básicos: 10000 = 1×, 12500 = 1,25×. */
  surgeMultiplierBasisPoints: z.int().min(10_000),
  surgeApplied: z.boolean(),
});

// --- Billetera -----------------------------------------------------------------

/** `GET /v1/wallets/{fleetId}` (saldo). */
export const walletViewSchema = z.object({
  fleetId: fleetIdSchema,
  balance: moneySchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * `PUT /v1/wallets/{fleetId}`: abre la billetera con saldo 0 en la moneda
 * configurada del servicio. 201 creada · 200 ya existía. El cliente nunca fija el saldo.
 */
export const openWalletRequestSchema = z.strictObject({});
export const openWalletResponseSchema = walletViewSchema;

/**
 * `GET /v1/wallets/{fleetId}/funds-check?energyKwh=&connectorPowerKw=`: verifica
 * si el saldo cubre el cargo estimado (consulta; no retiene fondos).
 */
export const fundsCheckQuerySchema = z.strictObject({
  energyKwh: z.coerce.number().pipe(energyKwhSchema),
  connectorPowerKw: z.coerce.number().pipe(powerKwSchema),
});
export const fundsCheckViewSchema = z.object({
  fleetId: fleetIdSchema,
  sufficient: z.boolean(),
  required: moneySchema,
  available: moneySchema,
  pricing: pricingViewSchema,
});

/**
 * Movimiento del libro mayor (auditable): operación que lo originó
 * (`operationId` = débito, reembolso o recarga), SAGA, `correlationId` e
 * `idempotencyKey` de la petición.
 */
export const walletTransactionViewSchema = z.object({
  transactionId: walletTransactionIdSchema,
  fleetId: fleetIdSchema,
  type: walletTransactionTypeSchema,
  amount: positiveMoneySchema,
  balanceAfter: moneySchema,
  operationId: z.string().min(1),
  sagaId: sagaIdSchema.optional(),
  debitId: debitIdSchema.optional(),
  refundId: refundIdSchema.optional(),
  topUpId: topUpIdSchema.optional(),
  correlationId: correlationIdSchema,
  idempotencyKey: z.string().min(1),
  occurredAt: isoDateTimeSchema,
});

/** `GET /v1/wallets/{fleetId}/transactions?limit=&cursor=` (más reciente primero). */
export const listWalletTransactionsQuerySchema = paginationQuerySchema;
export const listWalletTransactionsResponseSchema = z.object({
  items: z.array(walletTransactionViewSchema),
  nextCursor: z.string().optional(),
});

// --- Débitos y reembolsos ---------------------------------------------------

export const debitViewSchema = z.object({
  debitId: debitIdSchema,
  sagaId: sagaIdSchema,
  fleetId: fleetIdSchema,
  status: debitStatusSchema,
  amount: moneySchema,
  pricing: pricingViewSchema,
  /** Reembolso que lo compensó (solo en REFUNDED). */
  refundId: refundIdSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * `PUT /v1/debits/{debitId}`: cargo del importe estimado (paso 2 de la SAGA).
 * El importe lo calcula el servicio (tarifa × energía × surge), no el cliente.
 * - 201 DEBITED · 200 repetición idéntica (no cobra dos veces).
 * - 422 INSUFFICIENT_FUNDS (definitivo; el rechazo queda registrado y se repite igual).
 * - 409 DEBIT_VOIDED (tombstone) · 409 IDEMPOTENCY_CONFLICT · 404 WALLET_NOT_FOUND.
 * Cabeceras: `sagaCommandHeadersSchema` (`x-saga-id` = `sagaId`).
 */
export const debitRequestSchema = z.strictObject({
  sagaId: sagaIdSchema,
  fleetId: fleetIdSchema,
  energyKwh: energyKwhSchema,
  connectorPowerKw: powerKwSchema,
});
export const debitResponseSchema = debitViewSchema;

/**
 * `POST /v1/debits` con cabecera `idempotency-key` (UUID): misma operación; el id
 * del débito se deriva de la clave (`dbt_<clave>`). Misma clave y cuerpo → 200;
 * otro cuerpo → 409 IDEMPOTENCY_CONFLICT.
 */
export const createDebitRequestSchema = debitRequestSchema;

/** `GET /v1/debits/{debitId}` → `debitViewSchema` · 404 DEBIT_NOT_FOUND · 409 DEBIT_VOIDED (tombstone). */

/**
 * `POST /v1/debits/{debitId}/refund` (compensación, operación propia e idempotente):
 * crea el reembolso `rfd_<valor del débito>` y su movimiento REFUND.
 * - REFUNDED · ALREADY_REFUNDED · NOTHING_TO_REFUND (el débito fue rechazado)
 * - VOIDED: no existía; tombstone que bloquea un `PUT` tardío.
 * - 409 DEBIT_MISMATCH: `x-saga-id` no es la SAGA del débito.
 * Cabeceras: `sagaCommandHeadersSchema`; `idempotency-key` opcional (se registra).
 */
export const refundDebitRequestSchema = z.strictObject({ reason: compensationReasonSchema });
export const refundDebitResponseSchema = z.object({
  debitId: debitIdSchema,
  status: debitStatusSchema,
  outcome: z.enum(REFUND_OUTCOMES),
  refundId: refundIdSchema.optional(),
});

/**
 * `PUT /v1/wallets/{fleetId}/top-ups/{topUpId}`: recarga (solo `platform-admins`,
 * vía graphql-api). Idempotente por `topUpId`; otro importe → 409 IDEMPOTENCY_CONFLICT.
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
  DEBIT_MISMATCH: 409,
  IDEMPOTENCY_CONFLICT: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export const problemSchema = problemSchemaFor(ERROR_CODES);

// --- Tipos -------------------------------------------------------------------

export type WalletView = z.output<typeof walletViewSchema>;
export type WalletTransactionView = z.output<typeof walletTransactionViewSchema>;
export type DebitView = z.output<typeof debitViewSchema>;
export type DebitRequest = z.output<typeof debitRequestSchema>;
export type FundsCheckView = z.output<typeof fundsCheckViewSchema>;
export type RefundDebitRequest = z.output<typeof refundDebitRequestSchema>;
export type RefundDebitResponse = z.output<typeof refundDebitResponseSchema>;
export type TopUpRequest = z.output<typeof topUpRequestSchema>;
