import { billingWalletV1 as api } from '@aegisvolt/contracts';

/**
 * Patrones de ruta Express derivados del contrato. No se usan los constructores
 * `api.paths.*` porque codifican los parámetros (`:` → `%3A`).
 */
const base = api.API.basePath;

export const ROUTES = {
  wallet: `${base}/wallets/:fleetId`,
  fundsCheck: `${base}/wallets/:fleetId/funds-check`,
  walletTransactions: `${base}/wallets/:fleetId/transactions`,
  topUp: `${base}/wallets/:fleetId/top-ups/:topUpId`,
  debits: `${base}/debits`,
  debit: `${base}/debits/:debitId`,
  refundDebit: `${base}/debits/:debitId/refund`,
} as const;
