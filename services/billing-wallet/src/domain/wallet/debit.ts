import type { DebitId, FleetId, SagaId } from '../shared/identifiers.ts';
import type { Energy } from '../pricing/energy.ts';
import type { PriceQuote } from '../pricing/pricing-policy.ts';
import { InvalidDebitTransitionError } from './errors.ts';

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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Cargo estimado de una SAGA (paso 2). Ciclo de vida:
 *   DEBITED ──refund──▶ REFUNDED
 *   REJECTED_INSUFFICIENT_FUNDS (terminal; se persiste para responder igual al reintento)
 */
export class Debit {
  readonly id: DebitId;
  readonly terms: DebitTerms;
  readonly quote: PriceQuote;
  readonly status: DebitStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: DebitProps) {
    this.id = props.id;
    this.terms = props.terms;
    this.quote = props.quote;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static applied(id: DebitId, terms: DebitTerms, quote: PriceQuote, now: Date): Debit {
    return new Debit({ id, terms, quote, status: 'DEBITED', createdAt: now, updatedAt: now });
  }

  static rejected(id: DebitId, terms: DebitTerms, quote: PriceQuote, now: Date): Debit {
    return new Debit({
      id,
      terms,
      quote,
      status: 'REJECTED_INSUFFICIENT_FUNDS',
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: DebitProps): Debit {
    return new Debit(props);
  }

  get amount() {
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

  markRefunded(now: Date): Debit {
    if (this.status !== 'DEBITED') {
      throw new InvalidDebitTransitionError(`El débito ${this.id} está ${this.status}`);
    }
    return new Debit({ ...this.toProps(), status: 'REFUNDED', updatedAt: now });
  }

  private toProps(): DebitProps {
    return {
      id: this.id,
      terms: this.terms,
      quote: this.quote,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

/** Tombstone: se compensó (refund) un id de débito que nunca llegó a cobrarse (ADR-0005). */
export class DebitTombstone {
  readonly id: DebitId;
  readonly voidedAt: Date;

  private constructor(id: DebitId, voidedAt: Date) {
    this.id = id;
    this.voidedAt = voidedAt;
  }

  static create(id: DebitId, now: Date): DebitTombstone {
    return new DebitTombstone(id, now);
  }
}
