import { InvalidValueError } from '../shared/domain-error.ts';

/** Coordenadas WGS84 de una electrolinera. */
export class GeoLocation {
  readonly latitude: number;
  readonly longitude: number;

  private constructor(latitude: number, longitude: number) {
    this.latitude = latitude;
    this.longitude = longitude;
  }

  static of(latitude: number, longitude: number): GeoLocation {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new InvalidValueError('latitude', 'debe estar entre -90 y 90');
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new InvalidValueError('longitude', 'debe estar entre -180 y 180');
    }
    return new GeoLocation(latitude, longitude);
  }

  equals(other: GeoLocation): boolean {
    return this.latitude === other.latitude && this.longitude === other.longitude;
  }
}

/** Ciudad como *slug* estable (p. ej. `bogota`); clave de agrupación del panel. */
export class City {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  static of(value: string): City {
    if (!/^[a-z]+(-[a-z]+)*$/.test(value)) {
      throw new InvalidValueError('city', 'debe ser un slug en minúsculas (p. ej. bogota)');
    }
    return new City(value);
  }

  equals(other: City): boolean {
    return this.value === other.value;
  }
}

/** Potencia de un conector en kW. Desde 150 kW se considera ultra-carga. */
export class PowerKw {
  static readonly ULTRA_FAST_THRESHOLD = 150;
  static readonly MAX = 1000;

  readonly value: number;

  private constructor(value: number) {
    this.value = value;
  }

  static of(value: number): PowerKw {
    if (!Number.isFinite(value) || value <= 0 || value > PowerKw.MAX) {
      throw new InvalidValueError('maxPowerKw', `debe ser > 0 y ≤ ${PowerKw.MAX}`);
    }
    return new PowerKw(value);
  }

  get isUltraFast(): boolean {
    return this.value >= PowerKw.ULTRA_FAST_THRESHOLD;
  }
}

export const CONNECTOR_TYPES = ['CCS2', 'CHADEMO', 'TYPE2', 'GBT'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
