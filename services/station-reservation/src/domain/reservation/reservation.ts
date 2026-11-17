import { InvalidValueError } from '../shared/domain-error.ts';
import type {
  ConnectorId,
  FleetId,
  ReservationId,
  SagaId,
  StationId,
} from '../shared/identifiers.ts';
import {
  ReservationHoldExpiredError,
  ReservationMismatchError,
  ReservationNotHeldError,
} from './errors.ts';

export const RESERVATION_STATUSES = ['HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RELEASE_REASONS = [
  'INSUFFICIENT_FUNDS',
  'CHARGER_HARDWARE_FAULT',
  'FORWARD_STEP_FAILED',
  'RECOVERY_DEADLINE_EXCEEDED',
  'OPERATOR_REQUEST',
] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

/** Términos inmutables de una reserva: identifican la petición para la idempotencia. */
export interface ReservationTerms {
  readonly sagaId: SagaId;
  readonly fleetId: FleetId;
  readonly stationId: StationId;
  readonly connectorId: ConnectorId;
  readonly fastChargeBoost: boolean;
}

export interface ReservationProps {
  readonly id: ReservationId;
  readonly terms: ReservationTerms;
  readonly status: ReservationStatus;
  readonly holdExpiresAt: Date;
  readonly releaseReason?: ReleaseReason;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ReleaseOutcome = 'RELEASED' | 'ALREADY_RELEASED';

/**
 * Reserva de un conector (bloqueo temporal). Ciclo de vida:
 *
 *   HELD ──confirm──▶ CONFIRMED ──release──▶ RELEASED
 *    │ └────────────release────────────────▶ RELEASED
 *    └──expire (hold vencido)──▶ EXPIRED
 *
 * RELEASED y EXPIRED son terminales; `release` sobre ellos es idempotente.
 */
export class Reservation {
  readonly id: ReservationId;
  readonly terms: ReservationTerms;
  readonly status: ReservationStatus;
  readonly holdExpiresAt: Date;
  readonly releaseReason: ReleaseReason | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: ReservationProps) {
    this.id = props.id;
    this.terms = props.terms;
    this.status = props.status;
    this.holdExpiresAt = props.holdExpiresAt;
    this.releaseReason = props.releaseReason;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static hold(input: {
    id: ReservationId;
    terms: ReservationTerms;
    holdDurationMs: number;
    now: Date;
  }): Reservation {
    if (!Number.isInteger(input.holdDurationMs) || input.holdDurationMs <= 0) {
      throw new InvalidValueError('holdDurationMs', 'debe ser un entero positivo');
    }
    return new Reservation({
      id: input.id,
      terms: input.terms,
      status: 'HELD',
      holdExpiresAt: new Date(input.now.getTime() + input.holdDurationMs),
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: ReservationProps): Reservation {
    if (props.status === 'RELEASED' && props.releaseReason === undefined) {
      throw new InvalidValueError('releaseReason', 'obligatorio en una reserva RELEASED');
    }
    return new Reservation(props);
  }

  isHoldExpiredAt(now: Date): boolean {
    return this.status === 'HELD' && this.holdExpiresAt.getTime() <= now.getTime();
  }

  /** ¿La petición tiene exactamente los mismos términos? (PUT idempotente). */
  hasSameTerms(terms: ReservationTerms): boolean {
    return (
      this.terms.sagaId === terms.sagaId &&
      this.terms.fleetId === terms.fleetId &&
      this.terms.stationId === terms.stationId &&
      this.terms.connectorId === terms.connectorId &&
      this.terms.fastChargeBoost === terms.fastChargeBoost
    );
  }

  /** Estado efectivo en `now`: un HELD vencido se ve EXPIRED aunque no se haya persistido. */
  effectiveStatusAt(now: Date): ReservationStatus {
    return this.isHoldExpiredAt(now) ? 'EXPIRED' : this.status;
  }

  /**
   * Solo la SAGA dueña de la reserva puede confirmarla o liberarla: evita que una
   * petición equivocada libere la reserva de otra flota.
   */
  assertRequestedBy(sagaId: SagaId): void {
    if (this.terms.sagaId !== sagaId) {
      throw new ReservationMismatchError(
        `La reserva ${this.id} pertenece a otra SAGA; no puede operarla ${sagaId}`,
      );
    }
  }

  confirm(now: Date): Reservation {
    if (this.status === 'CONFIRMED') {
      return this;
    }
    if (this.status !== 'HELD') {
      throw new ReservationNotHeldError(`La reserva ${this.id} está ${this.status}`);
    }
    if (this.isHoldExpiredAt(now)) {
      throw new ReservationHoldExpiredError(`El hold de ${this.id} venció`);
    }
    return this.with({ status: 'CONFIRMED', updatedAt: now });
  }

  release(reason: ReleaseReason, now: Date): { reservation: Reservation; outcome: ReleaseOutcome } {
    if (this.status === 'RELEASED' || this.status === 'EXPIRED') {
      return { reservation: this, outcome: 'ALREADY_RELEASED' };
    }
    return {
      reservation: this.with({ status: 'RELEASED', releaseReason: reason, updatedAt: now }),
      outcome: 'RELEASED',
    };
  }

  expire(now: Date): Reservation {
    if (!this.isHoldExpiredAt(now)) {
      throw new ReservationNotHeldError(`La reserva ${this.id} no tiene un hold vencido`);
    }
    return this.with({ status: 'EXPIRED', updatedAt: now });
  }

  private with(
    changes: Pick<ReservationProps, 'status' | 'updatedAt'> & { releaseReason?: ReleaseReason },
  ): Reservation {
    const releaseReason = changes.releaseReason ?? this.releaseReason;
    return new Reservation({
      id: this.id,
      terms: this.terms,
      holdExpiresAt: this.holdExpiresAt,
      createdAt: this.createdAt,
      status: changes.status,
      updatedAt: changes.updatedAt,
      ...(releaseReason === undefined ? {} : { releaseReason }),
    });
  }
}

/**
 * Tombstone: se compensó (`release`) un id de reserva que nunca llegó a crearse.
 * Bloquea un `PUT` tardío con ese id (ADR-0005).
 */
export class ReservationTombstone {
  readonly id: ReservationId;
  readonly reason: ReleaseReason;
  readonly voidedAt: Date;

  private constructor(id: ReservationId, reason: ReleaseReason, voidedAt: Date) {
    this.id = id;
    this.reason = reason;
    this.voidedAt = voidedAt;
  }

  static create(id: ReservationId, reason: ReleaseReason, now: Date): ReservationTombstone {
    return new ReservationTombstone(id, reason, now);
  }
}
