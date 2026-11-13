import { InvalidValueError } from '../shared/domain-error.ts';
import type { SessionId } from '../shared/identifiers.ts';
import { TelemetryOutOfOrderError } from '../session/errors.ts';

/**
 * Lectura del cargador. Campos mínimos: session_id (de la sesión), voltage,
 * current, power_kw, energy_kwh y timestamp; la temperatura es opcional.
 */
export interface TelemetryReading {
  readonly timestamp: Date;
  readonly voltageV: number;
  readonly currentA: number;
  readonly powerKw: number;
  /** Energía entregada ACUMULADA en la sesión. */
  readonly energyKwh: number;
  readonly temperatureC?: number;
}

/** Tolerancia de la comprobación física P ≈ V × I (medidores, pérdidas, redondeos). */
const POWER_TOLERANCE_RATIO = 0.1;
const POWER_TOLERANCE_MIN_KW = 1;

function assertRange(field: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new InvalidValueError(field, `debe estar entre ${min} y ${max}`);
  }
}

/**
 * Lectura de telemetría de una sesión (inmutable). Invariantes:
 * - rangos físicos plausibles;
 * - coherencia física: `powerKw ≈ voltageV × currentA / 1000` (±10 %, mínimo 1 kW);
 * - respecto de la lectura anterior: tiempo estrictamente creciente y energía
 *   acumulada no decreciente.
 */
export class TelemetryRecord {
  readonly sessionId: SessionId;
  readonly timestamp: Date;
  readonly voltageV: number;
  readonly currentA: number;
  readonly powerKw: number;
  readonly energyKwh: number;
  readonly temperatureC: number | undefined;

  private constructor(sessionId: SessionId, reading: TelemetryReading) {
    this.sessionId = sessionId;
    this.timestamp = reading.timestamp;
    this.voltageV = reading.voltageV;
    this.currentA = reading.currentA;
    this.powerKw = reading.powerKw;
    this.energyKwh = reading.energyKwh;
    this.temperatureC = reading.temperatureC;
  }

  static create(sessionId: SessionId, reading: TelemetryReading): TelemetryRecord {
    if (Number.isNaN(reading.timestamp.getTime())) {
      throw new InvalidValueError('timestamp', 'fecha inválida');
    }
    assertRange('voltageV', reading.voltageV, 0, 1500);
    assertRange('currentA', reading.currentA, 0, 1000);
    assertRange('powerKw', reading.powerKw, 0, 1000);
    assertRange('energyKwh', reading.energyKwh, 0, 500);
    if (reading.temperatureC !== undefined) {
      assertRange('temperatureC', reading.temperatureC, -40, 120);
    }
    const expectedKw = (reading.voltageV * reading.currentA) / 1000;
    const tolerance = Math.max(POWER_TOLERANCE_MIN_KW, expectedKw * POWER_TOLERANCE_RATIO);
    if (Math.abs(reading.powerKw - expectedKw) > tolerance) {
      throw new InvalidValueError(
        'powerKw',
        `incoherente con voltaje × corriente (${expectedKw.toFixed(1)} kW esperados)`,
      );
    }
    return new TelemetryRecord(sessionId, reading);
  }

  /** ¿Misma lectura (para reintentos idempotentes con el mismo timestamp)? */
  sameReadingAs(other: TelemetryRecord): boolean {
    return (
      this.sessionId === other.sessionId &&
      this.timestamp.getTime() === other.timestamp.getTime() &&
      this.voltageV === other.voltageV &&
      this.currentA === other.currentA &&
      this.powerKw === other.powerKw &&
      this.energyKwh === other.energyKwh &&
      this.temperatureC === other.temperatureC
    );
  }

  /** Valida que la lectura pueda seguir a la última registrada en la sesión. */
  assertFollows(previous: { timestamp: Date; energyKwh: number } | undefined): void {
    if (previous === undefined) {
      return;
    }
    if (this.timestamp.getTime() <= previous.timestamp.getTime()) {
      throw new TelemetryOutOfOrderError('La lectura no es posterior a la anterior');
    }
    if (this.energyKwh < previous.energyKwh) {
      throw new TelemetryOutOfOrderError('La energía acumulada no puede disminuir');
    }
  }
}
