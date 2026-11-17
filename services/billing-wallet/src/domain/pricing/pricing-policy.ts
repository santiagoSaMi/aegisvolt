import { InvalidValueError } from '../shared/domain-error.ts';
import { Money } from '../money/money.ts';
import type { Energy } from './energy.ts';

export const POWER_CLASSES = ['STANDARD', 'FAST', 'ULTRA_FAST'] as const;
export type PowerClass = (typeof POWER_CLASSES)[number];

/** < 50 kW estándar; 50–149,9 kW rápida; ≥ 150 kW ultra-carga. */
export function powerClassFor(connectorPowerKw: number): PowerClass {
  if (!Number.isFinite(connectorPowerKw) || connectorPowerKw <= 0 || connectorPowerKw > 1000) {
    throw new InvalidValueError('connectorPowerKw', 'debe ser > 0 y ≤ 1000');
  }
  if (connectorPowerKw >= 150) {
    return 'ULTRA_FAST';
  }
  return connectorPowerKw >= 50 ? 'FAST' : 'STANDARD';
}

/** Ventana pico en minutos del día **locales**: [startMinute, endMinute). */
export interface PeakWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface PricingPolicyConfig {
  readonly currency: string;
  /** Tarifa por kWh en unidades menores, por clase de potencia. */
  readonly tariffMinorPerKwh: Readonly<Record<PowerClass, number>>;
  /** Multiplicador de surge en puntos básicos (12500 = 1,25×). */
  readonly surgeMultiplierBasisPoints: number;
  readonly peakWindows: readonly PeakWindow[];
  /** Desfase local respecto de UTC (Bogotá: -300; sin horario de verano). */
  readonly utcOffsetMinutes: number;
}

export interface PriceQuote {
  readonly amount: Money;
  readonly tariffMinorPerKwh: number;
  readonly surgeMultiplierBasisPoints: number;
  readonly surgeApplied: boolean;
}

const BASIS_POINTS = 10_000;
const MINUTES_PER_DAY = 1440;

/**
 * Política de precios (ENABLE_DYNAMIC_SURGE_PRICING):
 *   importe = tarifa(clase) × energía × (surge si la flag está activa y es hora pico)
 * Cálculo exacto con enteros (BigInt) y redondeo half-up a la unidad menor.
 */
export class PricingPolicy {
  readonly config: PricingPolicyConfig;

  constructor(config: PricingPolicyConfig) {
    Money.zero(config.currency); // valida el código de moneda
    for (const powerClass of POWER_CLASSES) {
      const tariff = config.tariffMinorPerKwh[powerClass];
      if (!Number.isSafeInteger(tariff) || tariff <= 0) {
        throw new InvalidValueError(`tariffMinorPerKwh.${powerClass}`, 'debe ser un entero > 0');
      }
    }
    if (
      !Number.isInteger(config.surgeMultiplierBasisPoints) ||
      config.surgeMultiplierBasisPoints < BASIS_POINTS
    ) {
      throw new InvalidValueError('surgeMultiplierBasisPoints', 'debe ser un entero ≥ 10000 (1×)');
    }
    for (const window of config.peakWindows) {
      const valid =
        Number.isInteger(window.startMinute) &&
        Number.isInteger(window.endMinute) &&
        window.startMinute >= 0 &&
        window.endMinute <= MINUTES_PER_DAY &&
        window.startMinute < window.endMinute;
      if (!valid) {
        throw new InvalidValueError(
          'peakWindows',
          'cada ventana debe cumplir 0 ≤ inicio < fin ≤ 1440',
        );
      }
    }
    if (!Number.isInteger(config.utcOffsetMinutes) || Math.abs(config.utcOffsetMinutes) > 14 * 60) {
      throw new InvalidValueError('utcOffsetMinutes', 'debe ser un entero entre -840 y 840');
    }
    this.config = config;
  }

  isPeakAt(instant: Date): boolean {
    const utcMinute = instant.getUTCHours() * 60 + instant.getUTCMinutes();
    const localMinute =
      (((utcMinute + this.config.utcOffsetMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
      MINUTES_PER_DAY;
    return this.config.peakWindows.some(
      (window) => localMinute >= window.startMinute && localMinute < window.endMinute,
    );
  }

  quote(input: {
    energy: Energy;
    connectorPowerKw: number;
    at: Date;
    surgePricingEnabled: boolean;
  }): PriceQuote {
    const tariffMinorPerKwh = this.config.tariffMinorPerKwh[powerClassFor(input.connectorPowerKw)];
    const surgeApplied = input.surgePricingEnabled && this.isPeakAt(input.at);
    const multiplier = surgeApplied ? this.config.surgeMultiplierBasisPoints : BASIS_POINTS;

    // tarifa [minor/kWh] × Wh × bp / (1000 Wh/kWh × 10000 bp), redondeo half-up.
    const numerator =
      BigInt(tariffMinorPerKwh) * BigInt(input.energy.wattHours) * BigInt(multiplier);
    const denominator = 1000n * BigInt(BASIS_POINTS);
    const amountMinor = (numerator + denominator / 2n) / denominator;

    return {
      amount: Money.of(Number(amountMinor), this.config.currency),
      tariffMinorPerKwh,
      surgeMultiplierBasisPoints: multiplier,
      surgeApplied,
    };
  }
}
