import { describe, expect, it } from 'vitest';

import {
  ConnectorUnavailableError,
  FastChargeBoostDisabledError,
  InvalidValueError,
  Reservation,
  ReservationCancelledError,
  ReservationHoldExpiredError,
  ReservationMismatchError,
  ReservationNotHeldError,
  ReservationPolicy,
  ReservationTermsMismatchError,
  ReservationTombstone,
  SagaId,
  StationId,
  UltraFastRequiresBoostError,
  confirmReservation,
  holdConnector,
  releaseReservation,
} from '../../src/domain/index.ts';
import { NOW, OTHER_RESERVATION_ID, RESERVATION_ID, at, connector, terms } from './fixtures.ts';

const policy = new ReservationPolicy();
const SAGA_ID = terms().sagaId;
const OTHER_SAGA_ID = SagaId.parse('saga_00000000-0000-4000-8000-000000000009');

function hold(overrides: Partial<Parameters<typeof holdConnector>[0]> = {}) {
  return holdConnector({
    reservationId: RESERVATION_ID,
    terms: terms(),
    connector: connector(),
    existing: undefined,
    tombstone: undefined,
    policy,
    fastChargeBoostEnabled: false,
    now: NOW,
    ...overrides,
  });
}

function created() {
  const result = hold();
  if (result.kind !== 'CREATED') {
    throw new Error('se esperaba CREATED');
  }
  return result;
}

describe('Reservation: transiciones', () => {
  it('HELD → CONFIRMED → RELEASED', () => {
    const { reservation } = created();
    expect(reservation.status).toBe('HELD');
    expect(reservation.holdExpiresAt).toEqual(at(120_000));

    const confirmed = reservation.confirm(at(5_000));
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirm(at(6_000))).toBe(confirmed);

    const { reservation: released, outcome } = confirmed.release('OPERATOR_REQUEST', at(7_000));
    expect(released.status).toBe('RELEASED');
    expect(released.releaseReason).toBe('OPERATOR_REQUEST');
    expect(outcome).toBe('RELEASED');
  });

  it('release repetido devuelve ALREADY_RELEASED sin cambios', () => {
    const { reservation } = created();
    const first = reservation.release('INSUFFICIENT_FUNDS', at(1_000));
    const second = first.reservation.release('INSUFFICIENT_FUNDS', at(2_000));

    expect(second.outcome).toBe('ALREADY_RELEASED');
    expect(second.reservation).toBe(first.reservation);
  });

  it('no confirma un hold vencido ni una reserva liberada', () => {
    const { reservation } = created();
    expect(() => reservation.confirm(at(120_000))).toThrow(ReservationHoldExpiredError);

    const released = reservation.release('CHARGER_HARDWARE_FAULT', at(1_000)).reservation;
    expect(() => released.confirm(at(2_000))).toThrow(ReservationNotHeldError);
  });

  it('un HELD vencido se ve EXPIRED y expire lo persiste', () => {
    const { reservation } = created();
    expect(reservation.effectiveStatusAt(at(1_000))).toBe('HELD');
    expect(reservation.effectiveStatusAt(at(120_000))).toBe('EXPIRED');
    expect(() => reservation.expire(at(1_000))).toThrow(ReservationNotHeldError);
    expect(reservation.expire(at(120_000)).status).toBe('EXPIRED');
    expect(reservation.expire(at(120_000)).release('OPERATOR_REQUEST', at(121_000)).outcome).toBe(
      'ALREADY_RELEASED',
    );
  });

  it('solo la SAGA dueña puede operar la reserva', () => {
    const { reservation } = created();
    expect(() => {
      reservation.assertRequestedBy(SAGA_ID);
    }).not.toThrow();
    expect(() => {
      reservation.assertRequestedBy(OTHER_SAGA_ID);
    }).toThrow(ReservationMismatchError);
  });

  it('restore exige releaseReason en una reserva RELEASED', () => {
    const { reservation } = created();
    expect(() =>
      Reservation.restore({
        id: reservation.id,
        terms: reservation.terms,
        status: 'RELEASED',
        holdExpiresAt: reservation.holdExpiresAt,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow(InvalidValueError);
  });
});

describe('ReservationPolicy (ENABLE_FAST_CHARGE_BOOST)', () => {
  it('hold estándar de 120 s y extendido de 300 s con boost', () => {
    const base = { connector: connector() };
    expect(
      policy.holdDurationFor({ ...base, fastChargeBoost: false, fastChargeBoostEnabled: false }),
    ).toBe(120_000);
    expect(
      policy.holdDurationFor({ ...base, fastChargeBoost: true, fastChargeBoostEnabled: true }),
    ).toBe(300_000);
  });

  it('boost con la flag apagada → FAST_CHARGE_BOOST_DISABLED', () => {
    expect(() =>
      policy.holdDurationFor({
        connector: connector(),
        fastChargeBoost: true,
        fastChargeBoostEnabled: false,
      }),
    ).toThrow(FastChargeBoostDisabledError);
  });

  it('ultra-carga sin boost → ULTRA_FAST_REQUIRES_BOOST', () => {
    expect(() =>
      policy.holdDurationFor({
        connector: connector(180),
        fastChargeBoost: false,
        fastChargeBoostEnabled: true,
      }),
    ).toThrow(UltraFastRequiresBoostError);
  });

  it('valida su configuración', () => {
    expect(() => new ReservationPolicy({ standardHoldMs: 0, boostedHoldMs: 1 })).toThrow(
      InvalidValueError,
    );
    expect(() => new ReservationPolicy({ standardHoldMs: 10, boostedHoldMs: 5 })).toThrow(
      InvalidValueError,
    );
  });
});

describe('holdConnector (paso 1 de la SAGA, idempotente)', () => {
  it('crea la reserva y bloquea el conector hasta el mismo instante', () => {
    const result = created();
    expect(result.connector.hold?.reservationId).toBe(result.reservation.id);
    expect(result.connector.hold?.expiresAt).toEqual(result.reservation.holdExpiresAt);
    expect(result.displacedReservationId).toBeUndefined();
  });

  it('repetir con los mismos términos devuelve la reserva existente (REPLAYED)', () => {
    const { reservation } = created();
    expect(hold({ existing: reservation, now: at(3_000) })).toEqual({
      kind: 'REPLAYED',
      reservation,
    });
  });

  it('el mismo id con otros términos es un conflicto de idempotencia', () => {
    const { reservation } = created();
    expect(() => hold({ existing: reservation, terms: terms({ fastChargeBoost: true }) })).toThrow(
      ReservationTermsMismatchError,
    );
  });

  it('un tombstone bloquea la creación tardía (la compensación llegó antes)', () => {
    const tombstone = ReservationTombstone.create(RESERVATION_ID, 'FORWARD_STEP_FAILED', NOW);
    expect(() => hold({ tombstone })).toThrow(ReservationCancelledError);
  });

  it('rechaza un conector de otra estación', () => {
    expect(() => hold({ terms: terms({ stationId: StationId.parse('st_med-01') }) })).toThrow(
      InvalidValueError,
    );
  });

  it('dos reservas sobre el mismo conector: solo la primera obtiene el hold', () => {
    const { connector: held } = created();
    expect(() =>
      hold({ reservationId: OTHER_RESERVATION_ID, connector: held, now: at(1_000) }),
    ).toThrow(ConnectorUnavailableError);
  });

  it('tomar un conector con hold vencido informa la reserva desplazada', () => {
    const { connector: held } = created();
    const result = hold({ reservationId: OTHER_RESERVATION_ID, connector: held, now: at(130_000) });

    expect(result.kind).toBe('CREATED');
    if (result.kind === 'CREATED') {
      expect(result.displacedReservationId).toBe(RESERVATION_ID);
      expect(result.connector.hold?.reservationId).toBe(OTHER_RESERVATION_ID);
    }
  });
});

describe('releaseReservation (compensación)', () => {
  it('libera reserva y conector', () => {
    const { reservation, connector: held } = created();
    const result = releaseReservation({
      reservationId: reservation.id,
      reservation,
      connector: held,
      reason: 'INSUFFICIENT_FUNDS',
      requestedBy: SAGA_ID,
      now: at(1_000),
    });

    expect(result.outcome).toBe('RELEASED');
    if (result.outcome !== 'VOIDED') {
      expect(result.reservation.status).toBe('RELEASED');
      expect(result.connector?.status).toBe('AVAILABLE');
    }
  });

  it('rechaza la liberación pedida por otra SAGA (RESERVATION_MISMATCH)', () => {
    const { reservation, connector: held } = created();
    expect(() =>
      releaseReservation({
        reservationId: reservation.id,
        reservation,
        connector: held,
        reason: 'OPERATOR_REQUEST',
        requestedBy: OTHER_SAGA_ID,
        now: at(1_000),
      }),
    ).toThrow(ReservationMismatchError);
  });

  it('si la reserva no existe, registra un tombstone (VOIDED)', () => {
    const result = releaseReservation({
      reservationId: RESERVATION_ID,
      reservation: undefined,
      connector: undefined,
      reason: 'FORWARD_STEP_FAILED',
      requestedBy: SAGA_ID,
      now: NOW,
    });

    expect(result.outcome).toBe('VOIDED');
    if (result.outcome === 'VOIDED') {
      expect(result.tombstone.id).toBe(RESERVATION_ID);
    }
  });
});

describe('confirmReservation (fin de la SAGA)', () => {
  it('confirma la reserva y ocupa el conector', () => {
    const { reservation, connector: held } = created();
    const result = confirmReservation({
      reservation,
      connector: held,
      requestedBy: SAGA_ID,
      now: at(5_000),
    });

    expect(result.reservation.status).toBe('CONFIRMED');
    expect(result.connector.status).toBe('OCCUPIED');
  });

  it('otra SAGA no puede confirmarla', () => {
    const { reservation, connector: held } = created();
    expect(() =>
      confirmReservation({ reservation, connector: held, requestedBy: OTHER_SAGA_ID, now: NOW }),
    ).toThrow(ReservationMismatchError);
  });
});
