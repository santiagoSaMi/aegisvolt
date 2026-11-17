import { describe, expect, it } from 'vitest';

import {
  City,
  GeoLocation,
  InvalidValueError,
  PowerKw,
  Station,
  StationId,
} from '../../src/domain/index.ts';

describe('identificadores', () => {
  it('acepta ids con el prefijo del tipo y rechaza los demás', () => {
    expect(StationId.parse('st_bog-norte-01')).toBe('st_bog-norte-01');
    expect(() => StationId.parse('cn_01')).toThrow(InvalidValueError);
    expect(() => StationId.parse('st_BOG')).toThrow(/stationId/);
  });
});

describe('GeoLocation', () => {
  it('acepta coordenadas válidas', () => {
    expect(GeoLocation.of(4.711, -74.0721).equals(GeoLocation.of(4.711, -74.0721))).toBe(true);
  });

  it.each([
    [91, 0],
    [0, -181],
    [Number.NaN, 0],
  ])('rechaza (%s, %s)', (lat, lng) => {
    expect(() => GeoLocation.of(lat, lng)).toThrow(InvalidValueError);
  });
});

describe('City', () => {
  it('normaliza la ciudad como slug', () => {
    expect(City.of('santa-marta').value).toBe('santa-marta');
    expect(() => City.of('Bogotá')).toThrow(InvalidValueError);
  });
});

describe('PowerKw', () => {
  it('clasifica la ultra-carga desde 150 kW', () => {
    expect(PowerKw.of(149.9).isUltraFast).toBe(false);
    expect(PowerKw.of(150).isUltraFast).toBe(true);
  });

  it.each([0, -1, 1001, Number.POSITIVE_INFINITY])('rechaza %s kW', (value) => {
    expect(() => PowerKw.of(value)).toThrow(InvalidValueError);
  });
});

describe('Station', () => {
  it('recorta el nombre y exige que no esté vacío', () => {
    const base = {
      id: StationId.parse('st_bog-norte-01'),
      city: City.of('bogota'),
      location: GeoLocation.of(4.7, -74.05),
    };
    expect(Station.create({ ...base, name: '  Electrolinera Norte  ' }).name).toBe(
      'Electrolinera Norte',
    );
    expect(() => Station.create({ ...base, name: '   ' })).toThrow(InvalidValueError);
    expect(() => Station.create({ ...base, name: 'x'.repeat(121) })).toThrow(InvalidValueError);
  });
});
