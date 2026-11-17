import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  DebitWallet,
  GetDebit,
  GetTransactionHistory,
  GetWalletBalance,
  OpenWallet,
  RefundWallet,
  TopUpWallet,
  VerifyFunds,
  type Clock,
  type FeatureFlagReader,
} from './application/index.ts';
import { PricingPolicy, type PricingPolicyConfig } from './domain/index.ts';
import { DynamoDbWalletRepository } from './infrastructure/dynamodb/dynamodb-wallet-repository.ts';

/**
 * Cableado de casos de uso con el repositorio DynamoDB. Lo usan `main.ts` y las
 * pruebas de integración (con reloj y flags controlados).
 */
export function createUseCases(deps: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  clock: Clock;
  flags: FeatureFlagReader;
  pricing: PricingPolicyConfig;
}) {
  const wallets = new DynamoDbWalletRepository(deps.documentClient, deps.tableName);
  const pricing = new PricingPolicy(deps.pricing);
  const { clock, flags } = deps;

  return {
    openWallet: new OpenWallet({ wallets, clock, currency: deps.pricing.currency }),
    getWalletBalance: new GetWalletBalance({ wallets }),
    verifyFunds: new VerifyFunds({ wallets, pricing, flags, clock }),
    getTransactionHistory: new GetTransactionHistory({ wallets }),
    topUpWallet: new TopUpWallet({ wallets, clock }),
    debitWallet: new DebitWallet({ wallets, pricing, flags, clock }),
    refundWallet: new RefundWallet({ wallets, clock }),
    getDebit: new GetDebit({ wallets }),
  };
}
