import {
  ConnectorUnavailableError,
  ReservationHoldExpiredError,
  ReservationNotHeldError,
} from '../reservation/errors.ts';
import { InvalidValueError } from '../shared/domain-error.ts';
import type { ConnectorId, ReservationId, StationId } from '../shared/identifiers.ts';
import type { ConnectorType, PowerKw } from './value-objects.ts';

/**
 * Estados del conector:
 * - AVAILABLE: libre.
 * - RESERVED: bloqueo temporal (hold) de una reserva; vence en `hold.expiresAt`.
 * - OCCUPIED: la carga está en curso (SAGA confirmada); el bloqueo ya no vence.
 * - OUT_OF_SERVICE (adicional): mantenimiento o avería física; nunca se ofrece.
 */
export const CONNECTOR_STATUSES = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** Reserva que bloquea u ocupa el conector. */
export interface ConnectorHold {
  readonly reservationId: ReservationId;
  readonly expiresAt: Date;
}

export interface ChargingConnectorProps {
  readonly id: ConnectorId;
  readonly stationId: StationId;
  readonly type: ConnectorType;
  readonly maxPower: PowerKw;
  readonly status: ConnectorStatus;
  readonly hold?: ConnectorHold;
}

const STATUSES_WITH_HOLD: readonly ConnectorStatus[] = ['RESERVED', 'OCCUPIED'];

/**
 * Conector de carga (agregado). Invariantes:
 * - Existe `hold` ⇔ el estado es RESERVED u OCCUPIED.
 * - Un RESERVED vencido cuenta como disponible (vencimiento perezoso, evaluado
 *   con el reloj de la petición; no depende del borrado TTL de DynamoDB).
 *
 *   AVAILABLE ──placeHold──▶ RESERVED ──confirmHold──▶ OCCUPIED
 *       ▲                        │ (vence → disponible)     │
 *       └────────release─────────┴──────────release─────────┘
 *   AVAILABLE ⇄ OUT_OF_SERVICE
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
    if (STATUSES_WITH_HOLD.includes(props.status) !== (props.hold !== undefined)) {
      throw new InvalidValueError('status', 'RESERVED u OCCUPIED si y solo si existe un hold');
    }
    return new ChargingConnector(props);
  }

  get ultraFast(): boolean {
    return this.maxPower.isUltraFast;
  }

  isAvailableAt(now: Date): boolean {
    return this.status === 'AVAILABLE' || this.hasExpiredHold(now);
  }

  /** Estado efectivo en `now` (un RESERVED vencido se ve AVAILABLE). */
  effectiveStatusAt(now: Date): ConnectorStatus {
    return this.hasExpiredHold(now) ? 'AVAILABLE' : this.status;
  }

  /** Reserva vencida que se desplazaría al tomar el conector, si la hay. */
  expiredHoldAt(now: Date): ReservationId | undefined {
    return this.hasExpiredHold(now) ? this.hold?.reservationId : undefined;
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
    return this.with('RESERVED', { reservationId, expiresAt });
  }

  /** La carga empieza (SAGA confirmada): RESERVED → OCCUPIED. Idempotente. */
  confirmHold(reservationId: ReservationId, now: Date): ChargingConnector {
    if (this.hold?.reservationId !== reservationId) {
      throw new ReservationNotHeldError(
        `El conector ${this.id} no está bloqueado por ${reservationId}`,
      );
    }
    if (this.status === 'OCCUPIED') {
      return this;
    }
    if (this.hasExpiredHold(now)) {
      throw new ReservationHoldExpiredError(`El hold de ${reservationId} venció`);
    }
    return this.with('OCCUPIED', this.hold);
  }

  /**
   * Libera el conector solo si lo bloquea u ocupa esa reserva. Si no (ya liberado
   * o tomado por otra reserva tras vencer), no hace nada: nunca libera el bloqueo
   * de otra reserva.
   */
  release(reservationId: ReservationId): ChargingConnector {
    if (this.hold?.reservationId !== reservationId) {
      return this;
    }
    return this.with('AVAILABLE', undefined);
  }

  takeOutOfService(now: Date): ChargingConnector {
    if (this.status === 'OUT_OF_SERVICE') {
      return this;
    }
    if (!this.isAvailableAt(now)) {
      throw new ConnectorUnavailableError(`El conector ${this.id} tiene una reserva activa`);
    }
    return this.with('OUT_OF_SERVICE', undefined);
  }

  returnToService(): ChargingConnector {
    return this.status === 'OUT_OF_SERVICE' ? this.with('AVAILABLE', undefined) : this;
  }

  private hasExpiredHold(now: Date): boolean {
    return (
      this.status === 'RESERVED' &&
      this.hold !== undefined &&
      this.hold.expiresAt.getTime() <= now.getTime()
    );
  }

  private with(status: ConnectorStatus, hold: ConnectorHold | undefined): ChargingConnector {
    return new ChargingConnector({
      id: this.id,
      stationId: this.stationId,
      type: this.type,
      maxPower: this.maxPower,
      status,
      ...(hold === undefined ? {} : { hold }),
    });
  }
}
