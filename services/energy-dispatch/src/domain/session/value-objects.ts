import { InvalidValueError } from '../shared/domain-error.ts';

/** Energía solicitada para una sesión, en Wh enteros (máximo 500 kWh). */
export class RequestedEnergy {
  static readonly MAX_WATT_HOURS = 500_000;

  readonly wattHours: number;

  private constructor(wattHours: number) {
    this.wattHours = wattHours;
  }

  static fromKwh(kwh: number): RequestedEnergy {
    if (!Number.isFinite(kwh) || kwh <= 0) {
      throw new InvalidValueError('energyKwh', 'debe ser > 0');
    }
    const wattHours = Math.round(kwh * 1000);
    if (Math.abs(kwh * 1000 - wattHours) > 1e-6 || wattHours > RequestedEnergy.MAX_WATT_HOURS) {
      throw new InvalidValueError('energyKwh', 'debe ser ≤ 500 kWh con resolución de 1 Wh');
    }
    return new RequestedEnergy(wattHours);
  }

  get kwh(): number {
    return this.wattHours / 1000;
  }

  equals(other: RequestedEnergy): boolean {
    return this.wattHours === other.wattHours;
  }
}

/**
 * Falla reportada por el cargador (p. ej. `E-HW-001`). `simulated` indica que la
 * produjo la flag `SIMULATE_CHARGER_HARDWARE_FAULT` y no el hardware.
 */
export class ChargerFault {
  readonly code: string;
  readonly simulated: boolean;

  private constructor(code: string, simulated: boolean) {
    this.code = code;
    this.simulated = simulated;
  }

  static of(code: string, simulated: boolean): ChargerFault {
    if (!/^E-[A-Z]{2,4}-\d{3}$/.test(code)) {
      throw new InvalidValueError('faultCode', 'debe tener el formato E-XX-000');
    }
    return new ChargerFault(code, simulated);
  }

  /** Falla usada al simular un fallo de hardware (demo de rollback de la SAGA). */
  static simulatedHardwareFault(): ChargerFault {
    return new ChargerFault('E-HW-001', true);
  }
}
