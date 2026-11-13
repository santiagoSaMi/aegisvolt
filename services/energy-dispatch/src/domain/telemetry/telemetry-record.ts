import { InvalidValueError } from '../shared/domain-error.ts';
import type { SessionId } from '../shared/identifiers.ts';
import { TelemetryOutOfOrderError } from '../session/errors.ts';

export interface TelemetryReading {
  readonly recordedAt: Date;
  readonly powerKw: number;
  /** Energía entregada acumulada en la sesión. */
  readonly energyDeliveredKwh: number;
  readonly voltageV: number;
  readonly temperatureC: number;
}

function assertRange(field: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new InvalidValueError(field, `debe estar entre ${min} y ${max}`);
  }
}

/**
 * Lectura de telemetría de una sesión (inmutable). Invariantes: rangos físicos
 * plausibles y, respecto de la lectura anterior, tiempo estrictamente creciente
 * y energía acumulada no decreciente.
 */
export class TelemetryRecord {
  readonly sessionId: SessionId;
  readonly recordedAt: Date;
  readonly powerKw: number;
  readonly energyDeliveredKwh: number;
  readonly voltageV: number;
  readonly temperatureC: number;

  private constructor(sessionId: SessionId, reading: TelemetryReading) {
    this.sessionId = sessionId;
    this.recordedAt = reading.recordedAt;
    this.powerKw = reading.powerKw;
    this.energyDeliveredKwh = reading.energyDeliveredKwh;
    this.voltageV = reading.voltageV;
    this.temperatureC = reading.temperatureC;
  }

  static create(sessionId: SessionId, reading: TelemetryReading): TelemetryRecord {
    if (Number.isNaN(reading.recordedAt.getTime())) {
      throw new InvalidValueError('recordedAt', 'fecha inválida');
    }
    assertRange('powerKw', reading.powerKw, 0, 1000);
    assertRange('energyDeliveredKwh', reading.energyDeliveredKwh, 0, 500);
    assertRange('voltageV', reading.voltageV, 0, 1500);
    assertRange('temperatureC', reading.temperatureC, -40, 120);
    return new TelemetryRecord(sessionId, reading);
  }

  /** Valida que esta lectura pueda seguir a `previous` en la misma sesión. */
  assertFollows(previous: TelemetryRecord | undefined): void {
    if (previous === undefined) {
      return;
    }
    if (previous.sessionId !== this.sessionId) {
      throw new TelemetryOutOfOrderError('Las lecturas pertenecen a sesiones distintas');
    }
    if (this.recordedAt.getTime() <= previous.recordedAt.getTime()) {
      throw new TelemetryOutOfOrderError('La lectura no es posterior a la anterior');
    }
    if (this.energyDeliveredKwh < previous.energyDeliveredKwh) {
      throw new TelemetryOutOfOrderError('La energía acumulada no puede disminuir');
    }
  }
}
