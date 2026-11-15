import { describe, expect, it } from 'vitest';

import { operationOutcome } from '../../src/presentation/graphql/log-operation-plugin.ts';

describe('operationOutcome', () => {
  it('solo los fallos del servidor cuentan como server_error', () => {
    expect(operationOutcome([])).toBe('ok');
    expect(operationOutcome(['UNAUTHENTICATED'])).toBe('client_error');
    expect(operationOutcome(['BAD_USER_INPUT', 'FORBIDDEN'])).toBe('client_error');
    expect(operationOutcome(['NOT_FOUND', 'SERVICE_UNAVAILABLE'])).toBe('server_error');
    expect(operationOutcome(['INTERNAL_SERVER_ERROR'])).toBe('server_error');
  });
});
