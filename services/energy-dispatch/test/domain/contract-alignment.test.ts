import { energyDispatchV1 } from '@aegisvolt/contracts';
import { describe, expect, it } from 'vitest';

import {
  ChargerFault,
  SESSION_STATUSES,
  SessionAbortedError,
  SessionAlreadyCompletedError,
  SessionTermsMismatchError,
} from '../../src/domain/index.ts';

/** El dominio no importa el contrato; esta prueba evita que diverjan. */
describe('alineación dominio ↔ contrato energy-dispatch v1', () => {
  it('vocabulario: el contrato añade VOIDED para los tombstones', () => {
    expect([...SESSION_STATUSES, 'VOIDED'].sort()).toEqual(
      [...energyDispatchV1.SESSION_STATUSES].sort(),
    );
  });

  it('el código de falla simulada es válido en el contrato', () => {
    expect(
      energyDispatchV1.faultCodeSchema.safeParse(ChargerFault.simulatedHardwareFault().code)
        .success,
    ).toBe(true);
  });

  it('cada error de negocio del dominio tiene su código en el catálogo HTTP', () => {
    const errors = [
      new SessionAbortedError('x'),
      new SessionAlreadyCompletedError('x'),
      new SessionTermsMismatchError('x'),
    ];
    for (const error of errors) {
      expect(energyDispatchV1.ERROR_CODES).toHaveProperty(error.code);
    }
  });
});
