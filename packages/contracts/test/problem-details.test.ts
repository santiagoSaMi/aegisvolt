import { describe, expect, it } from 'vitest';

import {
  HTTP_HEADERS,
  isProblemDetails,
  problemSchemaFor,
  stationReservationV1,
} from '../src/index.ts';

const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';

describe('isProblemDetails', () => {
  it('acepta un problem+json válido', () => {
    expect(
      isProblemDetails({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'ROUTE_NOT_FOUND',
        correlationId: CORRELATION_ID,
      }),
    ).toBe(true);
  });

  it.each([
    null,
    'texto',
    { title: 'Sin type', status: 404, code: 'X' },
    { type: 'about:blank', title: 'Sin code', status: 404 },
    { type: 'about:blank', title: 'Status no es error', status: 200, code: 'X' },
    { type: 'about:blank', title: 'Status decimal', status: 404.5, code: 'X' },
    { type: 'about:blank', title: 'Code en minúsculas', status: 404, code: 'not_found' },
    {
      type: 'about:blank',
      title: 'Correlation no UUID',
      status: 404,
      code: 'X',
      correlationId: 'c-1',
    },
  ])('rechaza %j', (value) => {
    expect(isProblemDetails(value)).toBe(false);
  });
});

describe('problemSchemaFor', () => {
  it('restringe code al catálogo de la API', () => {
    const schema = problemSchemaFor({ ONLY_THIS: 409 });
    const base = { type: 'about:blank', title: 'Conflict', status: 409 };

    expect(schema.safeParse({ ...base, code: 'ONLY_THIS' }).success).toBe(true);
    expect(schema.safeParse({ ...base, code: 'OTHER' }).success).toBe(false);
  });

  it('incluye los errores comunes en cada catálogo', () => {
    expect(stationReservationV1.ERROR_CODES.VALIDATION_ERROR).toBe(400);
    expect(stationReservationV1.ERROR_CODES.INTERNAL_ERROR).toBe(500);
  });
});

describe('HTTP_HEADERS', () => {
  it('usa nombres en minúsculas', () => {
    for (const name of Object.values(HTTP_HEADERS)) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});
