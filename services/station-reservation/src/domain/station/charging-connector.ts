import {
  ConnectorUnavailableError,
  ReservationHoldExpiredError,
  ReservationNotHeldError,
} from '../reservation/errors.ts';
import { InvalidValueError } from '../shared/domain-error.ts';
import type { ConnectorId, ReservationId, StationId } from '../shared/identifiers.ts';
import type { ConnectorType, PowerKw } from './value-objects.ts';

export const CONNECTOR_STATUSES = ['AVAILABLE', 'RESERVED', 'OUT_OF_SERVICE'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** Bloqueo del conector por una reserva. Confirmado = carga en curso (no vence). */
export interface ConnectorHold {
  readonly reservationId: ReservationId;
  readonly expiresAt: Date;
  readonly confirmed: boolean;
}

export interface ChargingConnectorProps {
  readonly id: ConnectorId;
  readonly stationId: StationId;
  readonly type: ConnectorType;
  readonly maxPower: PowerKw;
  readonly status: ConnectorStatus;
  readonly hold?: ConnectorHold;
}

/**
 * Conector de carga (agregado). Invariantes:
 * - `RESERVED` ⇔ existe `hold`.
 * - Un *hold* no confirmado y vencido deja el conector disponible (vencimiento perezoso,
 *   sin depender del TTL de DynamoDB).
 * Las transiciones devuelven una instancia nueva (inmutabilidad).
 */
export class ChargingConnector {
  readonly id: ConnectorId;
  readonly stationId: StationId;
  readonly type: ConnectorType;
  readonly maxPower: PowerKw;
  readonly status: ConnectorStatus;
  readonly hold: ConnectorHold | undefined;

  private constructor(props: ChargingConnectorProps) {
    this.id = props.id;
    this.stationId = props.stationId;
    this.type = props.type;
    this.maxPower = props.maxPower;
    this.status = props.status;
    this.hold = props.hold;
  }

  static create(props: Omit<ChargingConnectorProps, 'status' | 'hold'>): ChargingConnector {
    return new ChargingConnector({ ...props, status: 'AVAILABLE' });
  }

  /** Reconstruye desde persistencia validando las invariantes. */
  static restore(props: ChargingConnectorProps): ChargingConnector {
    if ((props.status === 'RESERVED') !== (props.hold !== undefined)) {
      throw new InvalidValueError('status', 'RESERVED si y solo si existe un hold');
    }
    return new ChargingConnector(props);
  }

  get ultraFast(): boolean {
    return this.maxPower.isUltraFast;
  }

  isAvailableAt(now: Date): boolean {
    if (this.status === 'AVAILABLE') {
      return true;
    }
    return this.hasExpiredHold(now);
  }

  /** Bloquea el conector para una reserva. Repetir con la misma reserva es idempotente. */
  placeHold(reservationId: ReservationId, expiresAt: Date, now: Date): ChargingConnector {
    if (this.hold?.reservationId === reservationId) {
      return this;
    }
    if (!this.isAvailableAt(now)) {
      throw new ConnectorUnavailableError(`El conector ${this.id} no está disponible`);
    }
    if (expiresAt.getTime() <= now.getTime()) {
      throw new InvalidValueError('expiresAt', 'el hold debe vencer en el futuro');
    }
    return this.with({ status: 'RESERVED', hold: { reservationId, expiresAt, confirmed: false } });
  }

  /** Confirma el hold al completar la SAGA: la carga en curso ya no vence. */
  confirmHold(reservationId: ReservationId, now: Date): ChargingConnector {
    if (this.hold?.reservationId !== reservationId) {
      throw new ReservationNotHeldError(
        `El conector ${this.id} no está bloqueado por ${reservationId}`,
      );
    }
    if (this.hold.confirmed) {
      return this;
    }
    if (this.hold.expiresAt.getTime() <= now.getTime()) {
      throw new ReservationHoldExpiredError(`El hold de ${reservationId} venció`);
    }
    return this.with({ status: 'RESERVED', hold: { ...this.hold, confirmed: true } });
  }

  /**
   * Libera el conector si lo tiene bloqueado esa reserva. Si no (ya liberado o
   * tomado por otra reserva tras vencer), no hace nada: compensación idempotente.
   */
  release(reservationId: ReservationId): ChargingConnector {
    if (this.hold?.reservationId !== reservationId) {
      return this;
    }
    return this.with({ status: 'AVAILABLE', hold: undefined });
  }

  takeOutOfService(now: Date): ChargingConnector {
    if (this.status === 'OUT_OF_SERVICE') {
      return this;
    }
    if (!this.isAvailableAt(now)) {
      throw new ConnectorUnavailableError(`El conector ${this.id} tiene una reserva activa`);
    }
    return this.with({ status: 'OUT_OF_SERVICE', hold: undefined });
  }

  returnToService(): ChargingConnector {
    return this.status === 'OUT_OF_SERVICE'
      ? this.with({ status: 'AVAILABLE', hold: undefined })
      : this;
  }

  private hasExpiredHold(now: Date): boolean {
    return (
      this.status === 'RESERVED' &&
      this.hold !== undefined &&
      !this.hold.confirmed &&
      this.hold.expiresAt.getTime() <= now.getTime()
    );
  }

  private with(changes: {
    status: ConnectorStatus;
    hold: ConnectorHold | undefined;
  }): ChargingConnector {
    return new ChargingConnector({
      id: this.id,
      stationId: this.stationId,
      type: this.type,
      maxPower: this.maxPower,
      status: changes.status,
      ...(changes.hold === undefined ? {} : { hold: changes.hold }),
    });
  }
}
