import { describe, expect, it } from 'vitest';

import {
  ChargingConnector,
  ConnectorUnavailableError,
  InvalidValueError,
  ReservationHoldExpiredError,
  ReservationNotHeldError,
} from '../../src/domain/index.ts';
import { NOW, OTHER_RESERVATION_ID, RESERVATION_ID, at, connector } from './fixtures.ts';

describe('ChargingConnector', () => {
  it('nace AVAILABLE y pasa a RESERVED con un hold', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);

    expect(held.status).toBe('RESERVED');
    expect(held.hold).toEqual({
      reservationId: RESERVATION_ID,
      expiresAt: at(120_000),
      confirmed: false,
    });
    expect(held.isAvailableAt(at(60_000))).toBe(false);
  });

  it('repetir el hold con la misma reserva es idempotente', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);
    expect(held.placeHold(RESERVATION_ID, at(999_000), at(1_000))).toBe(held);
  });

  it('rechaza un segundo hold de otra reserva mientras el primero está vigente', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);
    expect(() => held.placeHold(OTHER_RESERVATION_ID, at(240_000), at(1_000))).toThrow(
      ConnectorUnavailableError,
    );
  });

  it('un hold vencido no confirmado libera el conector (vencimiento perezoso)', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);

    expect(held.isAvailableAt(at(120_000))).toBe(true);
    const retaken = held.placeHold(OTHER_RESERVATION_ID, at(300_000), at(130_000));
    expect(retaken.hold?.reservationId).toBe(OTHER_RESERVATION_ID);
  });

  it('un hold confirmado no vence', () => {
    const confirmed = connector()
      .placeHold(RESERVATION_ID, at(120_000), NOW)
      .confirmHold(RESERVATION_ID, at(10_000));

    expect(confirmed.hold?.confirmed).toBe(true);
    expect(confirmed.isAvailableAt(at(10 * 60_000))).toBe(false);
    expect(confirmed.confirmHold(RESERVATION_ID, at(20_000))).toBe(confirmed);
  });

  it('no confirma un hold vencido ni de otra reserva', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);
    expect(() => held.confirmHold(RESERVATION_ID, at(120_000))).toThrow(
      ReservationHoldExpiredError,
    );
    expect(() => held.confirmHold(OTHER_RESERVATION_ID, at(1_000))).toThrow(
      ReservationNotHeldError,
    );
  });

  it('release es idempotente y no libera holds de otra reserva', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);

    expect(held.release(OTHER_RESERVATION_ID)).toBe(held);
    const released = held.release(RESERVATION_ID);
    expect(released.status).toBe('AVAILABLE');
    expect(released.hold).toBeUndefined();
    expect(released.release(RESERVATION_ID)).toBe(released);
  });

  it('no se saca de servicio con una reserva vigente', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);
    expect(() => held.takeOutOfService(at(1_000))).toThrow(ConnectorUnavailableError);

    const outOfService = connector().takeOutOfService(NOW);
    expect(outOfService.isAvailableAt(NOW)).toBe(false);
    expect(outOfService.returnToService().status).toBe('AVAILABLE');
  });

  it('restore valida la invariante RESERVED ⇔ hold', () => {
    const base = connector();
    expect(() =>
      ChargingConnector.restore({
        id: base.id,
        stationId: base.stationId,
        type: base.type,
        maxPower: base.maxPower,
        status: 'RESERVED',
      }),
    ).toThrow(InvalidValueError);
  });

  it('expone si es de ultra-carga', () => {
    expect(connector(60).ultraFast).toBe(false);
    expect(connector(150).ultraFast).toBe(true);
  });
});
