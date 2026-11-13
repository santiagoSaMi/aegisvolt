import { billingWalletV1 as api, fleetIdSchema, topUpIdSchema } from '@aegisvolt/contracts';
import { Router } from 'express';
import { z } from 'zod';

import type {
  GetTransactionHistory,
  GetWalletBalance,
  OpenWallet,
  TopUpWallet,
  VerifyFunds,
} from '../../../application/index.ts';
import { correlationIdOf } from '../middleware/correlation.ts';
import { sendJson } from '../problem.ts';
import { parseRequest } from '../validation.ts';
import { toFundsCheckView, toTransactionView, toWalletView } from '../views.ts';
import { ROUTES } from './route-patterns.ts';

export interface WalletUseCases {
  readonly openWallet: OpenWallet;
  readonly getWalletBalance: GetWalletBalance;
  readonly verifyFunds: VerifyFunds;
  readonly getTransactionHistory: GetTransactionHistory;
  readonly topUpWallet: TopUpWallet;
}

const walletParamsSchema = z.object({ fleetId: fleetIdSchema });
const topUpParamsSchema = walletParamsSchema.extend({ topUpId: topUpIdSchema });

/** Controllers delgados: validan con el contrato, delegan y mapean la respuesta. */
export function walletRoutes(useCases: WalletUseCases): Router {
  const router = Router();

  router.put(ROUTES.wallet, async (req, res) => {
    const { fleetId } = parseRequest(walletParamsSchema, req.params, 'params');
    parseRequest(api.openWalletRequestSchema, req.body ?? {}, 'body');
    const { outcome, wallet } = await useCases.openWallet.execute(fleetId);
    sendJson(res, outcome === 'CREATED' ? 201 : 200, toWalletView(wallet));
  });

  router.get(ROUTES.wallet, async (req, res) => {
    const { fleetId } = parseRequest(walletParamsSchema, req.params, 'params');
    sendJson(res, 200, toWalletView(await useCases.getWalletBalance.execute(fleetId)));
  });

  router.get(ROUTES.fundsCheck, async (req, res) => {
    const { fleetId } = parseRequest(walletParamsSchema, req.params, 'params');
    const query = parseRequest(api.fundsCheckQuerySchema, req.query, 'query');
    const check = await useCases.verifyFunds.execute({ fleetId, ...query });
    sendJson(res, 200, toFundsCheckView(check));
  });

  router.get(ROUTES.walletTransactions, async (req, res) => {
    const { fleetId } = parseRequest(walletParamsSchema, req.params, 'params');
    const { limit, cursor } = parseRequest(
      api.listWalletTransactionsQuerySchema,
      req.query,
      'query',
    );
    const page = await useCases.getTransactionHistory.execute({
      fleetId,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    sendJson(res, 200, {
      items: page.items.map(toTransactionView),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  /** Recarga administrativa: la clave idempotente es el `topUpId`. */
  router.put(ROUTES.topUp, async (req, res) => {
    const { fleetId, topUpId } = parseRequest(topUpParamsSchema, req.params, 'params');
    const { amount } = parseRequest(api.topUpRequestSchema, req.body, 'body');
    const result = await useCases.topUpWallet.execute({
      fleetId,
      topUpId,
      amount,
      audit: { correlationId: correlationIdOf(res) ?? '', idempotencyKey: topUpId },
    });
    sendJson(res, result.outcome === 'APPLIED' ? 201 : 200, {
      wallet: toWalletView(result.wallet),
      transaction: toTransactionView(result.transaction),
    });
  });

  return router;
}
