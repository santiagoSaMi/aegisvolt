import {
  DebitId,
  Energy,
  FleetId,
  Money,
  PricingPolicy,
  SagaId,
  Wallet,
  WalletTransactionId,
  type DebitTerms,
} from '../../src/domain/index.ts';

/** 15:00 UTC = 10:00 en Bogotá (fuera de la ventana pico). */
export const OFF_PEAK = new Date('2026-11-13T15:00:00.000Z');
/** 23:30 UTC = 18:30 en Bogotá (dentro de la ventana pico 17:00–21:00). */
export const PEAK = new Date('2026-11-13T23:30:00.000Z');

export const FLEET_ID = FleetId.parse('fleet_001');
export const SAGA_ID = SagaId.parse('saga_3f2c1e5a-1b2c-4d3e-8f90-123456789abc');
export const DEBIT_ID = DebitId.parse('dbt_3f2c1e5a-1b2c-4d3e-8f90-123456789abc');
export const TX_ID = WalletTransactionId.parse('wtx_00000000-0000-4000-8000-000000000001');
export const TX_ID_2 = WalletTransactionId.parse('wtx_00000000-0000-4000-8000-000000000002');

export const cop = (amountMinor: number): Money => Money.of(amountMinor, 'COP');

/** Tarifas en centavos de COP por kWh. */
export const pricing = new PricingPolicy({
  currency: 'COP',
  tariffMinorPerKwh: { STANDARD: 80_000, FAST: 100_000, ULTRA_FAST: 140_000 },
  surgeMultiplierBasisPoints: 12_500,
  peakWindows: [{ startMinute: 17 * 60, endMinute: 21 * 60 }],
  utcOffsetMinutes: -300,
});

export function wallet(balanceMinor: number): Wallet {
  return Wallet.restore({ fleetId: FLEET_ID, balance: cop(balanceMinor), updatedAt: OFF_PEAK });
}

export function terms(overrides: Partial<DebitTerms> = {}): DebitTerms {
  return {
    sagaId: SAGA_ID,
    fleetId: FLEET_ID,
    energy: Energy.fromKwh(30),
    connectorPowerKw: 60,
    ...overrides,
  };
}
