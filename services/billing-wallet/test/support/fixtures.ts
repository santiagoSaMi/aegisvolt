import {
  DebitWallet,
  GetDebit,
  GetTransactionHistory,
  GetWalletBalance,
  OpenWallet,
  RefundWallet,
  TopUpWallet,
  VerifyFunds,
  type DebitWalletCommand,
} from '../../src/application/index.ts';
import { PricingPolicy, type PricingPolicyConfig } from '../../src/domain/index.ts';
import { StaticFeatureFlagReader } from '../../src/infrastructure/feature-flags/static-feature-flag-reader.ts';
import { FixedClock, InMemoryWalletRepository } from './in-memory-wallet-repository.ts';

/** 15:00 UTC = 10:00 en Bogotá (fuera de hora pico). */
export const START = new Date('2026-11-13T15:00:00.000Z');
export const FLEET = 'fleet_001';
export const SAGA_A = 'saga_00000000-0000-4000-8000-00000000000a';
export const SAGA_B = 'saga_00000000-0000-4000-8000-00000000000b';
export const DEBIT_A = 'dbt_00000000-0000-4000-8000-00000000000a';
export const DEBIT_B = 'dbt_00000000-0000-4000-8000-00000000000b';
export const CORRELATION = '11111111-2222-4333-8444-555555555555';

export const PRICING: PricingPolicyConfig = {
  currency: 'COP',
  tariffMinorPerKwh: { STANDARD: 80_000, FAST: 100_000, ULTRA_FAST: 140_000 },
  surgeMultiplierBasisPoints: 12_500,
  peakWindows: [{ startMinute: 17 * 60, endMinute: 21 * 60 }],
  utcOffsetMinutes: -300,
};

/** 30 kWh en conector de 60 kW (FAST): 30 × 100 000 = 3 000 000 centavos. */
export const DEBIT_AMOUNT = 3_000_000;

export function debitCommand(overrides: Partial<DebitWalletCommand> = {}): DebitWalletCommand {
  return {
    debitId: DEBIT_A,
    sagaId: SAGA_A,
    fleetId: FLEET,
    energyKwh: 30,
    connectorPowerKw: 60,
    audit: { correlationId: CORRELATION, idempotencyKey: overrides.debitId ?? DEBIT_A },
    ...overrides,
  };
}

/** Casos de uso reales sobre el repositorio en memoria, con reloj y flags controlados. */
export function createTestContext(options: { surgePricing?: boolean } = {}) {
  const wallets = new InMemoryWalletRepository();
  const clock = new FixedClock(START);
  const flags = new StaticFeatureFlagReader({
    ENABLE_DYNAMIC_SURGE_PRICING: options.surgePricing ?? false,
  });
  const pricing = new PricingPolicy(PRICING);
  const useCases = {
    openWallet: new OpenWallet({ wallets, clock, currency: 'COP' }),
    getWalletBalance: new GetWalletBalance({ wallets }),
    verifyFunds: new VerifyFunds({ wallets, pricing, flags, clock }),
    getTransactionHistory: new GetTransactionHistory({ wallets }),
    topUpWallet: new TopUpWallet({ wallets, clock }),
    debitWallet: new DebitWallet({ wallets, pricing, flags, clock }),
    refundWallet: new RefundWallet({ wallets, clock }),
    getDebit: new GetDebit({ wallets }),
  };

  /** Abre la billetera y la recarga con `balanceMinor`. */
  async function fund(balanceMinor: number, fleetId = FLEET): Promise<void> {
    await useCases.openWallet.execute(fleetId);
    if (balanceMinor > 0) {
      await useCases.topUpWallet.execute({
        fleetId,
        topUpId: `tup_seed-${fleetId.replace('_', '-')}`,
        amount: { amountMinor: balanceMinor, currency: 'COP' },
        audit: { correlationId: CORRELATION, idempotencyKey: 'seed' },
      });
    }
  }

  return { wallets, clock, useCases, fund };
}
