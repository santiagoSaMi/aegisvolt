import { describe, expect, it } from 'vitest';

import { HTTP_HEADERS, isProblemDetails } from '../src/index.ts';

describe('isProblemDetails', () => {
  it('acepta un problem+json válido', () => {
    expect(
      isProblemDetails({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'ROUTE_NOT_FOUND',
        correlationId: 'c-123',
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
  ])('rechaza %j', (value) => {
    expect(isProblemDetails(value)).toBe(false);
  });
});

describe('HTTP_HEADERS', () => {
  it('usa nombres en minúsculas', () => {
    for (const name of Object.values(HTTP_HEADERS)) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});
