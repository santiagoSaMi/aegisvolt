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
    expect(held.hold).toEqual({ reservationId: RESERVATION_ID, expiresAt: at(120_000) });
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

  it('un hold vencido deja el conector disponible (vencimiento perezoso)', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);

    expect(held.isAvailableAt(at(120_000))).toBe(true);
    expect(held.effectiveStatusAt(at(120_000))).toBe('AVAILABLE');
    expect(held.expiredHoldAt(at(120_000))).toBe(RESERVATION_ID);
    expect(held.expiredHoldAt(at(1_000))).toBeUndefined();

    const retaken = held.placeHold(OTHER_RESERVATION_ID, at(300_000), at(130_000));
    expect(retaken.hold?.reservationId).toBe(OTHER_RESERVATION_ID);
  });

  it('confirmar el hold ocupa el conector (OCCUPIED) y ya no vence', () => {
    const occupied = connector()
      .placeHold(RESERVATION_ID, at(120_000), NOW)
      .confirmHold(RESERVATION_ID, at(10_000));

    expect(occupied.status).toBe('OCCUPIED');
    expect(occupied.isAvailableAt(at(10 * 60_000))).toBe(false);
    expect(occupied.effectiveStatusAt(at(10 * 60_000))).toBe('OCCUPIED');
    expect(occupied.confirmHold(RESERVATION_ID, at(20_000))).toBe(occupied);
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

  it('release es idempotente y nunca libera el bloqueo de otra reserva', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);

    expect(held.release(OTHER_RESERVATION_ID)).toBe(held);
    const released = held.release(RESERVATION_ID);
    expect(released.status).toBe('AVAILABLE');
    expect(released.hold).toBeUndefined();
    expect(released.release(RESERVATION_ID)).toBe(released);
  });

  it('un conector OCCUPIED se libera al terminar', () => {
    const occupied = connector()
      .placeHold(RESERVATION_ID, at(120_000), NOW)
      .confirmHold(RESERVATION_ID, at(1_000));
    expect(occupied.release(RESERVATION_ID).status).toBe('AVAILABLE');
  });

  it('no se saca de servicio con una reserva vigente', () => {
    const held = connector().placeHold(RESERVATION_ID, at(120_000), NOW);
    expect(() => held.takeOutOfService(at(1_000))).toThrow(ConnectorUnavailableError);

    const outOfService = connector().takeOutOfService(NOW);
    expect(outOfService.isAvailableAt(NOW)).toBe(false);
    expect(outOfService.returnToService().status).toBe('AVAILABLE');
  });

  it('restore valida la invariante hold ⇔ RESERVED/OCCUPIED', () => {
    const base = connector();
    const props = {
      id: base.id,
      stationId: base.stationId,
      type: base.type,
      maxPower: base.maxPower,
    };
    expect(() => ChargingConnector.restore({ ...props, status: 'RESERVED' })).toThrow(
      InvalidValueError,
    );
    expect(() => ChargingConnector.restore({ ...props, status: 'OCCUPIED' })).toThrow(
      InvalidValueError,
    );
    expect(() =>
      ChargingConnector.restore({
        ...props,
        status: 'AVAILABLE',
        hold: { reservationId: RESERVATION_ID, expiresAt: NOW },
      }),
    ).toThrow(InvalidValueError);
  });

  it('expone si es de ultra-carga', () => {
    expect(connector(60).ultraFast).toBe(false);
    expect(connector(150).ultraFast).toBe(true);
  });
});
