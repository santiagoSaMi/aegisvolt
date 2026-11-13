import { InvalidValueError } from '../shared/domain-error.ts';

/**
 * Energía a facturar. Se guarda en **Wh enteros** (resolución de 1 Wh) para que
 * el cálculo del precio sea exacto. Máximo 500 kWh por carga.
 */
export class Energy {
  static readonly MAX_WATT_HOURS = 500_000;

  readonly wattHours: number;

  private constructor(wattHours: number) {
    this.wattHours = wattHours;
  }

  static fromKwh(kwh: number): Energy {
    if (!Number.isFinite(kwh) || kwh <= 0) {
      throw new InvalidValueError('energyKwh', 'debe ser > 0');
    }
    const wattHours = Math.round(kwh * 1000);
    if (Math.abs(kwh * 1000 - wattHours) > 1e-6) {
      throw new InvalidValueError('energyKwh', 'admite como máximo 3 decimales (1 Wh)');
    }
    if (wattHours > Energy.MAX_WATT_HOURS) {
      throw new InvalidValueError('energyKwh', 'debe ser ≤ 500 kWh');
    }
    return new Energy(wattHours);
  }

  get kwh(): number {
    return this.wattHours / 1000;
  }

  equals(other: Energy): boolean {
    return this.wattHours === other.wattHours;
  }
}
