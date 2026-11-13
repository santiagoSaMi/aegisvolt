import { InvalidValueError } from '../shared/domain-error.ts';
import type { ChargingConnector } from '../station/charging-connector.ts';
import { FastChargeBoostDisabledError, UltraFastRequiresBoostError } from './errors.ts';

export interface ReservationPolicyConfig {
  /** Duración del hold estándar (ms). */
  readonly standardHoldMs: number;
  /** Duración del hold con `fastChargeBoost` (ms). */
  readonly boostedHoldMs: number;
}

/** Valores de diseño: hold de 120 s; 300 s con fast charge boost (02-saga.md, P-11, P-14). */
export const DEFAULT_RESERVATION_POLICY: ReservationPolicyConfig = {
  standardHoldMs: 120_000,
  boostedHoldMs: 300_000,
};

/**
 * Reglas de reserva (ENABLE_FAST_CHARGE_BOOST, interpretación P-14 pendiente de
 * confirmar con el profesor):
 * - Pedir `fastChargeBoost` con la flag apagada → FAST_CHARGE_BOOST_DISABLED.
 * - Un conector de ultra-carga (≥ 150 kW) solo se reserva con `fastChargeBoost`.
 * - Con `fastChargeBoost`, el hold es más largo (prioridad).
 */
export class ReservationPolicy {
  readonly config: ReservationPolicyConfig;

  constructor(config: ReservationPolicyConfig = DEFAULT_RESERVATION_POLICY) {
    const { standardHoldMs, boostedHoldMs } = config;
    if (!Number.isInteger(standardHoldMs) || standardHoldMs <= 0) {
      throw new InvalidValueError('standardHoldMs', 'debe ser un entero positivo');
    }
    if (!Number.isInteger(boostedHoldMs) || boostedHoldMs < standardHoldMs) {
      throw new InvalidValueError('boostedHoldMs', 'debe ser un entero ≥ standardHoldMs');
    }
    this.config = config;
  }

  holdDurationFor(input: {
    connector: ChargingConnector;
    fastChargeBoost: boolean;
    fastChargeBoostEnabled: boolean;
  }): number {
    if (input.fastChargeBoost && !input.fastChargeBoostEnabled) {
      throw new FastChargeBoostDisabledError('ENABLE_FAST_CHARGE_BOOST está desactivada');
    }
    if (input.connector.ultraFast && !input.fastChargeBoost) {
      throw new UltraFastRequiresBoostError(
        `El conector ${input.connector.id} es de ultra-carga y requiere fastChargeBoost`,
      );
    }
    return input.fastChargeBoost ? this.config.boostedHoldMs : this.config.standardHoldMs;
  }
}
