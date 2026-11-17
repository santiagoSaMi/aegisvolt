import { describe, expect, it } from 'vitest';

import {
  ID_PREFIXES,
  correlationHeadersSchema,
  energyKwhSchema,
  idempotentCommandHeadersSchema,
  isoDateTimeSchema,
  moneySchema,
  paginationQuerySchema,
  sagaCommandHeadersSchema,
  sagaIdSchema,
  stationIdSchema,
} from '../src/index.ts';

const UUID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';

describe('identificadores', () => {
  it.each(['st_bog-norte-01', 'st_1', `st_${UUID}`])('acepta %s', (value) => {
    expect(stationIdSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    'bog-norte-01', // sin prefijo
    'cn_bog-01', // prefijo de otro tipo
    'st_Bog', // mayúsculas
    'st_-bog', // empieza con guion
    'st_', // valor vacío
    `st_${'a'.repeat(64)}`, // demasiado largo
  ])('rechaza %s', (value) => {
    expect(stationIdSchema.safeParse(value).success).toBe(false);
  });

  it('los prefijos son únicos', () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('acepta un id de SAGA generado con UUID', () => {
    expect(sagaIdSchema.parse(`saga_${UUID}`)).toBe(`saga_${UUID}`);
  });
});

describe('primitivas', () => {
  it('energyKwh: positiva, ≤ 500 y con resolución de 1 Wh', () => {
    expect(energyKwhSchema.safeParse(32.125).success).toBe(true);
    expect(energyKwhSchema.safeParse(0.3).success).toBe(true);
    expect(energyKwhSchema.safeParse(0).success).toBe(false);
    expect(energyKwhSchema.safeParse(500.001).success).toBe(false);
    expect(energyKwhSchema.safeParse(1.0001).success).toBe(false);
  });

  it('money: enteros no negativos en unidades menores y moneda ISO 4217', () => {
    expect(moneySchema.safeParse({ amountMinor: 1250000, currency: 'COP' }).success).toBe(true);
    expect(moneySchema.safeParse({ amountMinor: 12.5, currency: 'COP' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: -1, currency: 'COP' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: 1, currency: 'cop' }).success).toBe(false);
  });

  it('fechas: solo ISO-8601 en UTC', () => {
    expect(isoDateTimeSchema.safeParse('2026-11-13T15:04:05.000Z').success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-11-13T10:04:05-05:00').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('13/11/2026').success).toBe(false);
  });

  it('paginación: convierte el límite desde query string y aplica valores por defecto', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(paginationQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    expect(paginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '5', extra: 'x' }).success).toBe(false);
  });
});

describe('cabeceras', () => {
  it('exige x-correlation-id UUID e ignora las demás cabeceras', () => {
    const parsed = correlationHeadersSchema.parse({
      'x-correlation-id': UUID,
      'content-type': 'application/json',
    });
    expect(parsed).toEqual({ 'x-correlation-id': UUID });
    expect(correlationHeadersSchema.safeParse({ 'x-correlation-id': 'abc' }).success).toBe(false);
  });

  it('los comandos de la SAGA exigen además x-saga-id', () => {
    expect(sagaCommandHeadersSchema.safeParse({ 'x-correlation-id': UUID }).success).toBe(false);
    expect(
      sagaCommandHeadersSchema.safeParse({ 'x-correlation-id': UUID, 'x-saga-id': `saga_${UUID}` })
        .success,
    ).toBe(true);
  });

  it('POST idempotente exige idempotency-key UUID', () => {
    expect(
      idempotentCommandHeadersSchema.safeParse({
        'x-correlation-id': UUID,
        'idempotency-key': UUID,
      }).success,
    ).toBe(true);
    expect(
      idempotentCommandHeadersSchema.safeParse({ 'x-correlation-id': UUID, 'idempotency-key': '1' })
        .success,
    ).toBe(false);
  });
});
