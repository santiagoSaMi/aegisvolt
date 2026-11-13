import { beforeEach, describe, expect, it } from 'vitest';

import {
  ConcurrentModificationError,
  ConnectorNotFoundError,
  ReservationNotFoundError,
} from '../../src/application/index.ts';
import {
  ConnectorUnavailableError,
  FastChargeBoostDisabledError,
  ReservationCancelledError,
  ReservationMismatchError,
  ReservationTermsMismatchError,
  UltraFastRequiresBoostError,
} from '../../src/domain/index.ts';
import {
  CONNECTOR_ID,
  RES_A,
  RES_B,
  SAGA_A,
  SAGA_B,
  STATION,
  STATION_ID,
  ULTRA_CONNECTOR_ID,
  createTestContext,
  reservationCommand,
} from '../support/fixtures.ts';

let ctx: ReturnType<typeof createTestContext>;

beforeEach(async () => {
  ctx = createTestContext();
  await ctx.useCases.registerStation.execute(STATION);
});

const connectorState = () => ctx.store.connector(STATION_ID, CONNECTOR_ID);

describe('CreateReservation', () => {
  it('reserva un conector disponible: reserva HELD y conector RESERVED atómicamente', async () => {
    const result = await ctx.useCases.createReservation.execute(reservationCommand());

    expect(result.outcome).toBe('CREATED');
    expect(result.reservation.status).toBe('HELD');
    expect(connectorState()).toMatchObject({
      version: 2,
      value: { status: 'RESERVED', hold: { reservationId: RES_A } },
    });
    expect(ctx.store.writes).toBe(1);
  });

  it('reserva duplicada (misma clave y mismos datos) es idempotente: REPLAYED sin escribir', async () => {
    await ctx.useCases.createReservation.execute(reservationCommand());
    const replay = await ctx.useCases.createReservation.execute(reservationCommand());

    expect(replay.outcome).toBe('REPLAYED');
    expect(replay.reservation.id).toBe(RES_A);
    expect(ctx.store.writes).toBe(1);
  });

  it('reutilizar la clave con otros datos es un conflicto de idempotencia', async () => {
    await ctx.useCases.createReservation.execute(reservationCommand());
    await expect(
      ctx.useCases.createReservation.execute(reservationCommand({ fleetId: 'fleet_999' })),
    ).rejects.toBeInstanceOf(ReservationTermsMismatchError);
  });

  it('dos flotas a la vez sobre el mismo conector: exactamente una obtiene la reserva', async () => {
    const results = await Promise.allSettled([
      ctx.useCases.createReservation.execute(reservationCommand()),
      ctx.useCases.createReservation.execute(
        reservationCommand({ reservationId: RES_B, sagaId: SAGA_B, fleetId: 'fleet_002' }),
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConnectorUnavailableError);
    expect(connectorState()?.value.status).toBe('RESERVED');
  });

  it('la misma petición enviada dos veces a la vez crea una sola reserva', async () => {
    const [first, second] = await Promise.all([
      ctx.useCases.createReservation.execute(reservationCommand()),
      ctx.useCases.createReservation.execute(reservationCommand()),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['CREATED', 'REPLAYED']);
    expect(connectorState()?.version).toBe(2);
  });

  it('conector inexistente → CONNECTOR_NOT_FOUND', async () => {
    await expect(
      ctx.useCases.createReservation.execute(reservationCommand({ connectorId: 'cn_99' })),
    ).rejects.toBeInstanceOf(ConnectorNotFoundError);
  });

  it('el hold vence solo: otra flota toma el conector y la reserva vencida queda EXPIRED', async () => {
    await ctx.useCases.createReservation.execute(reservationCommand());
    ctx.clock.advance(120_000);

    const second = await ctx.useCases.createReservation.execute(
      reservationCommand({ reservationId: RES_B, sagaId: SAGA_B, fleetId: 'fleet_002' }),
    );

    expect(second.outcome).toBe('CREATED');
    expect(connectorState()?.value.hold?.reservationId).toBe(RES_B);
    expect(ctx.store.reservation(RES_A)?.value.status).toBe('EXPIRED');
  });

  it('ENABLE_FAST_CHARGE_BOOST: apagada rechaza el boost; la ultra-carga exige boost', async () => {
    await expect(
      ctx.useCases.createReservation.execute(reservationCommand({ fastChargeBoost: true })),
    ).rejects.toBeInstanceOf(FastChargeBoostDisabledError);
    await expect(
      ctx.useCases.createReservation.execute(
        reservationCommand({ connectorId: ULTRA_CONNECTOR_ID }),
      ),
    ).rejects.toBeInstanceOf(UltraFastRequiresBoostError);

    const boosted = createTestContext({ fastChargeBoost: true });
    await boosted.useCases.registerStation.execute(STATION);
    const result = await boosted.useCases.createReservation.execute(
      reservationCommand({ connectorId: ULTRA_CONNECTOR_ID, fastChargeBoost: true }),
    );
    expect(result.reservation.holdExpiresAt.getTime() - result.now.getTime()).toBe(300_000);
  });

  it('reintenta ante conflictos transitorios y se rinde tras 3 intentos', async () => {
    ctx.store.failNextWrites = 2;
    await expect(
      ctx.useCases.createReservation.execute(reservationCommand()),
    ).resolves.toMatchObject({ outcome: 'CREATED' });

    const fresh = createTestContext();
    await fresh.useCases.registerStation.execute(STATION);
    fresh.store.failNextWrites = 3;
    await expect(
      fresh.useCases.createReservation.execute(reservationCommand()),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  });
});

describe('ReleaseReservation', () => {
  beforeEach(async () => {
    await ctx.useCases.createReservation.execute(reservationCommand());
  });

  it('liberación válida: reserva RELEASED y conector AVAILABLE; repetirla es idempotente', async () => {
    const first = await ctx.useCases.releaseReservation.execute({
      reservationId: RES_A,
      sagaId: SAGA_A,
      reason: 'INSUFFICIENT_FUNDS',
    });
    expect(first.outcome).toBe('RELEASED');
    expect(connectorState()?.value.status).toBe('AVAILABLE');

    const writes = ctx.store.writes;
    const second = await ctx.useCases.releaseReservation.execute({
      reservationId: RES_A,
      sagaId: SAGA_A,
      reason: 'INSUFFICIENT_FUNDS',
    });
    expect(second.outcome).toBe('ALREADY_RELEASED');
    expect(ctx.store.writes).toBe(writes);
  });

  it('liberación inválida (otra SAGA): RESERVATION_MISMATCH y nada cambia', async () => {
    await expect(
      ctx.useCases.releaseReservation.execute({
        reservationId: RES_A,
        sagaId: SAGA_B,
        reason: 'OPERATOR_REQUEST',
      }),
    ).rejects.toBeInstanceOf(ReservationMismatchError);
    expect(ctx.store.reservation(RES_A)?.value.status).toBe('HELD');
    expect(connectorState()?.value.status).toBe('RESERVED');
  });

  it('reserva inexistente: deja un tombstone (VOIDED) que bloquea una creación tardía', async () => {
    const result = await ctx.useCases.releaseReservation.execute({
      reservationId: RES_B,
      sagaId: SAGA_B,
      reason: 'FORWARD_STEP_FAILED',
    });
    expect(result.outcome).toBe('VOIDED');

    await expect(
      ctx.useCases.createReservation.execute(
        reservationCommand({
          reservationId: RES_B,
          sagaId: SAGA_B,
          connectorId: ULTRA_CONNECTOR_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ReservationCancelledError);
  });

  it('nunca libera el conector si ya lo tomó otra reserva tras vencer', async () => {
    ctx.clock.advance(120_000);
    await ctx.useCases.createReservation.execute(
      reservationCommand({ reservationId: RES_B, sagaId: SAGA_B, fleetId: 'fleet_002' }),
    );

    const result = await ctx.useCases.releaseReservation.execute({
      reservationId: RES_A,
      sagaId: SAGA_A,
      reason: 'FORWARD_STEP_FAILED',
    });
    expect(result.outcome).toBe('ALREADY_RELEASED');
    expect(connectorState()?.value.hold?.reservationId).toBe(RES_B);
  });
});

describe('ConfirmReservation', () => {
  it('confirma: reserva CONFIRMED y conector OCCUPIED (ya no vence)', async () => {
    await ctx.useCases.createReservation.execute(reservationCommand());
    const { reservation } = await ctx.useCases.confirmReservation.execute({
      reservationId: RES_A,
      sagaId: SAGA_A,
    });

    expect(reservation.status).toBe('CONFIRMED');
    expect(connectorState()?.value.status).toBe('OCCUPIED');
    ctx.clock.advance(3_600_000);
    expect(connectorState()?.value.isAvailableAt(ctx.clock.now())).toBe(false);
  });

  it('otra SAGA no puede confirmar; una reserva inexistente → RESERVATION_NOT_FOUND', async () => {
    await ctx.useCases.createReservation.execute(reservationCommand());
    await expect(
      ctx.useCases.confirmReservation.execute({ reservationId: RES_A, sagaId: SAGA_B }),
    ).rejects.toBeInstanceOf(ReservationMismatchError);
    await expect(
      ctx.useCases.confirmReservation.execute({ reservationId: RES_B, sagaId: SAGA_B }),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
  });
});

describe('Consultas', () => {
  it('GetReservation: inexistente → RESERVATION_NOT_FOUND; estado efectivo EXPIRED tras vencer', async () => {
    await expect(ctx.useCases.getReservation.execute(RES_B)).rejects.toBeInstanceOf(
      ReservationNotFoundError,
    );
    await ctx.useCases.createReservation.execute(reservationCommand());
    ctx.clock.advance(120_000);
    const { reservation, now } = await ctx.useCases.getReservation.execute(RES_A);
    expect(reservation.effectiveStatusAt(now)).toBe('EXPIRED');
  });

  it('GetAvailableConnectors excluye los reservados y vuelve a incluirlos al vencer', async () => {
    await ctx.useCases.createReservation.execute(reservationCommand());
    const before = await ctx.useCases.getAvailableConnectors.execute({ stationId: STATION_ID });
    expect(before.items.map((item) => item.connector.id)).toEqual([ULTRA_CONNECTOR_ID]);

    ctx.clock.advance(120_000);
    const after = await ctx.useCases.getAvailableConnectors.execute({ city: 'bogota' });
    expect(after.items.map((item) => item.connector.id).sort()).toEqual([
      CONNECTOR_ID,
      ULTRA_CONNECTOR_ID,
    ]);
  });
});
