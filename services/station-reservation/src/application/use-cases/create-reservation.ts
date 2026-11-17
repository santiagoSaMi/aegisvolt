import {
  ConnectorId,
  FleetId,
  ReservationId,
  SagaId,
  StationId,
  holdConnector,
  type Reservation,
  type ReservationPolicy,
  type ReservationTerms,
} from '../../domain/index.ts';
import { ConnectorNotFoundError } from '../errors.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { ReservationRepository, VersionedUpdate } from '../ports/repositories.ts';
import type { Clock, FeatureFlagReader } from '../ports/services.ts';

export interface CreateReservationCommand {
  /** Clave de idempotencia del recurso (pre-generada por el cliente). */
  readonly reservationId: string;
  readonly sagaId: string;
  readonly fleetId: string;
  readonly stationId: string;
  readonly connectorId: string;
  readonly fastChargeBoost: boolean;
}

export interface CreateReservationResult {
  /** CREATED: se reservó ahora · REPLAYED: repetición idempotente de la misma petición. */
  readonly outcome: 'CREATED' | 'REPLAYED';
  readonly reservation: Reservation;
  readonly now: Date;
}

/**
 * Reserva temporal de un conector (paso 1 de la SAGA).
 *
 * Atomicidad: la reserva y el bloqueo del conector se escriben en una única
 * transacción condicionada a que el conector no haya cambiado desde la lectura
 * (versión) y a que el id de reserva no exista. Si dos flotas reservan a la vez
 * el mismo conector, solo una transacción gana; la otra se reintenta con datos
 * frescos y el dominio responde CONNECTOR_UNAVAILABLE.
 */
export class CreateReservation {
  private readonly reservations: ReservationRepository;
  private readonly flags: FeatureFlagReader;
  private readonly policy: ReservationPolicy;
  private readonly clock: Clock;

  constructor(deps: {
    reservations: ReservationRepository;
    flags: FeatureFlagReader;
    policy: ReservationPolicy;
    clock: Clock;
  }) {
    this.reservations = deps.reservations;
    this.flags = deps.flags;
    this.policy = deps.policy;
    this.clock = deps.clock;
  }

  execute(command: CreateReservationCommand): Promise<CreateReservationResult> {
    const reservationId = ReservationId.parse(command.reservationId);
    const terms: ReservationTerms = {
      sagaId: SagaId.parse(command.sagaId),
      fleetId: FleetId.parse(command.fleetId),
      stationId: StationId.parse(command.stationId),
      connectorId: ConnectorId.parse(command.connectorId),
      fastChargeBoost: command.fastChargeBoost,
    };
    return withOptimisticRetry(() => this.attempt(reservationId, terms));
  }

  private async attempt(
    reservationId: ReservationId,
    terms: ReservationTerms,
  ): Promise<CreateReservationResult> {
    const now = this.clock.now();
    const [stored, connector] = await Promise.all([
      this.reservations.findReservation(reservationId),
      this.reservations.findConnector(terms.stationId, terms.connectorId),
    ]);
    if (connector === undefined) {
      throw new ConnectorNotFoundError(
        `No existe el conector ${terms.connectorId} en ${terms.stationId}`,
      );
    }
    const fastChargeBoostEnabled = terms.fastChargeBoost
      ? await this.flags.isEnabled('ENABLE_FAST_CHARGE_BOOST')
      : false;

    const result = holdConnector({
      reservationId,
      terms,
      connector: connector.value,
      existing: stored?.kind === 'RESERVATION' ? stored.reservation.value : undefined,
      tombstone: stored?.kind === 'TOMBSTONE' ? stored.tombstone : undefined,
      policy: this.policy,
      fastChargeBoostEnabled,
      now,
    });
    if (result.kind === 'REPLAYED') {
      return { outcome: 'REPLAYED', reservation: result.reservation, now };
    }

    await this.reservations.saveHold({
      connector: { value: result.connector, expectedVersion: connector.version },
      reservation: result.reservation,
      displaced: await this.expireDisplaced(result.displacedReservationId, now),
      now,
    });
    return { outcome: 'CREATED', reservation: result.reservation, now };
  }

  /** La reserva cuyo hold venció y perdió el conector queda EXPIRED en la misma transacción. */
  private async expireDisplaced(
    displacedId: ReservationId | undefined,
    now: Date,
  ): Promise<VersionedUpdate<Reservation> | undefined> {
    if (displacedId === undefined) {
      return undefined;
    }
    const displaced = await this.reservations.findReservation(displacedId);
    if (displaced?.kind !== 'RESERVATION' || !displaced.reservation.value.isHoldExpiredAt(now)) {
      return undefined;
    }
    return {
      value: displaced.reservation.value.expire(now),
      expectedVersion: displaced.reservation.version,
    };
  }
}
