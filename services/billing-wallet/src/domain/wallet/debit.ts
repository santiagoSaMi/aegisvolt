import type { Money } from '../money/money.ts';
import type { Energy } from '../pricing/energy.ts';
import type { PriceQuote } from '../pricing/pricing-policy.ts';
import { InvalidValueError } from '../shared/domain-error.ts';
import type { DebitId, FleetId, RefundId, SagaId } from '../shared/identifiers.ts';
import type { OperationAudit } from '../shared/operation-audit.ts';
import { DebitMismatchError, InvalidDebitTransitionError } from './errors.ts';

export const DEBIT_STATUSES = ['DEBITED', 'REFUNDED', 'REJECTED_INSUFFICIENT_FUNDS'] as const;
export type DebitStatus = (typeof DEBIT_STATUSES)[number];

/** Términos de la petición de débito: identifican la petición para la idempotencia. */
export interface DebitTerms {
  readonly sagaId: SagaId;
  readonly fleetId: FleetId;
  readonly energy: Energy;
  readonly connectorPowerKw: number;
}

export interface DebitProps {
  readonly id: DebitId;
  readonly terms: DebitTerms;
  readonly quote: PriceQuote;
  readonly status: DebitStatus;
  readonly audit: OperationAudit;
  /** Reembolso que lo compensó (solo en REFUNDED). */
  readonly refundId?: RefundId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Cargo estimado de una SAGA (paso 2). El importe lo calcula la política de
 * precios del servicio; el cliente nunca lo define. Ciclo de vida:
 *   DEBITED ──refund──▶ REFUNDED (una sola vez)
 *   REJECTED_INSUFFICIENT_FUNDS (terminal; se persiste para responder igual al reintento)
 */
export class Debit {
  readonly id: DebitId;
  readonly terms: DebitTerms;
  readonly quote: PriceQuote;
  readonly status: DebitStatus;
  readonly audit: OperationAudit;
  readonly refundId: RefundId | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: DebitProps) {
    this.id = props.id;
    this.terms = props.terms;
    this.quote = props.quote;
    this.status = props.status;
    this.audit = props.audit;
    this.refundId = props.refundId;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static applied(
    id: DebitId,
    terms: DebitTerms,
    quote: PriceQuote,
    audit: OperationAudit,
    now: Date,
  ): Debit {
    return new Debit({
      id,
      terms,
      quote,
      status: 'DEBITED',
      audit,
      createdAt: now,
      updatedAt: now,
    });
  }

  static rejected(
    id: DebitId,
    terms: DebitTerms,
    quote: PriceQuote,
    audit: OperationAudit,
    now: Date,
  ): Debit {
    return new Debit({
      id,
      terms,
      quote,
      status: 'REJECTED_INSUFFICIENT_FUNDS',
      audit,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: DebitProps): Debit {
    if ((props.status === 'REFUNDED') !== (props.refundId !== undefined)) {
      throw new InvalidValueError('refundId', 'obligatorio si y solo si el débito está REFUNDED');
    }
    return new Debit(props);
  }

  get amount(): Money {
    return this.quote.amount;
  }

  hasSameTerms(terms: DebitTerms): boolean {
    return (
      this.terms.sagaId === terms.sagaId &&
      this.terms.fleetId === terms.fleetId &&
      this.terms.energy.equals(terms.energy) &&
      this.terms.connectorPowerKw === terms.connectorPowerKw
    );
  }

  /** Solo la SAGA que originó el cargo puede compensarlo. */
  assertRequestedBy(sagaId: SagaId): void {
    if (this.terms.sagaId !== sagaId) {
      throw new DebitMismatchError(`El débito ${this.id} pertenece a otra SAGA`);
    }
  }

  markRefunded(refundId: RefundId, now: Date): Debit {
    if (this.status !== 'DEBITED') {
      throw new InvalidDebitTransitionError(`El débito ${this.id} está ${this.status}`);
    }
    return new Debit({
      id: this.id,
      terms: this.terms,
      quote: this.quote,
      status: 'REFUNDED',
      audit: this.audit,
      refundId,
      createdAt: this.createdAt,
      updatedAt: now,
    });
  }
}

/**
 * Tombstone: se compensó (refund) un id de débito que nunca llegó a cobrarse.
 * Bloquea un cobro tardío con ese id (ADR-0005) y deja constancia de quién lo pidió.
 */
export class DebitTombstone {
  readonly id: DebitId;
  readonly sagaId: SagaId;
  readonly audit: OperationAudit;
  readonly voidedAt: Date;

  private constructor(id: DebitId, sagaId: SagaId, audit: OperationAudit, voidedAt: Date) {
    this.id = id;
    this.sagaId = sagaId;
    this.audit = audit;
    this.voidedAt = voidedAt;
  }

  static create(id: DebitId, sagaId: SagaId, audit: OperationAudit, now: Date): DebitTombstone {
    return new DebitTombstone(id, sagaId, audit, now);
  }
}
