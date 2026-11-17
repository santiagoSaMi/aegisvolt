import { COMPENSATION_REASONS, stationReservationV1 } from '@aegisvolt/contracts';
import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_STATUSES,
  CONNECTOR_TYPES,
  ConnectorUnavailableError,
  FastChargeBoostDisabledError,
  RELEASE_REASONS,
  RESERVATION_STATUSES,
  ReservationCancelledError,
  ReservationHoldExpiredError,
  ReservationNotHeldError,
  ReservationTermsMismatchError,
  UltraFastRequiresBoostError,
} from '../../src/domain/index.ts';

/** El dominio no importa el contrato; esta prueba evita que diverjan. */
describe('alineación dominio ↔ contrato station-reservation v1', () => {
  it('vocabulario: el contrato añade VOIDED para los tombstones', () => {
    expect([...CONNECTOR_TYPES]).toEqual([...stationReservationV1.CONNECTOR_TYPES]);
    expect([...CONNECTOR_STATUSES]).toEqual([...stationReservationV1.CONNECTOR_STATUSES]);
    expect([...RESERVATION_STATUSES, 'VOIDED'].sort()).toEqual(
      [...stationReservationV1.RESERVATION_STATUSES].sort(),
    );
    expect([...RELEASE_REASONS]).toEqual([...COMPENSATION_REASONS]);
  });

  it('cada error de negocio del dominio tiene su código en el catálogo HTTP', () => {
    const errors = [
      new ConnectorUnavailableError('x'),
      new FastChargeBoostDisabledError('x'),
      new UltraFastRequiresBoostError('x'),
      new ReservationCancelledError('x'),
      new ReservationNotHeldError('x'),
      new ReservationHoldExpiredError('x'),
      new ReservationTermsMismatchError('x'),
    ];
    for (const error of errors) {
      expect(stationReservationV1.ERROR_CODES).toHaveProperty(error.code);
    }
  });
});
