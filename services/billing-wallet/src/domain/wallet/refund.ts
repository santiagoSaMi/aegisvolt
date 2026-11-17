import type { Money } from '../money/money.ts';
import { RefundId, type DebitId, type FleetId, type SagaId } from '../shared/identifiers.ts';
import type { OperationAudit } from '../shared/operation-audit.ts';
import type { Debit } from './debit.ts';

/** Motivos de compensación (mismo vocabulario que el contrato, COMPENSATION_REASONS). */
export const REFUND_REASONS = [
  'INSUFFICIENT_FUNDS',
  'CHARGER_HARDWARE_FAULT',
  'FORWARD_STEP_FAILED',
  'RECOVERY_DEADLINE_EXCEEDED',
  'OPERATOR_REQUEST',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/**
 * Reembolso: operación de negocio **independiente** que compensa un débito.
 * Tiene id propio (`rfd_…`, uno por débito), motivo, importe y trazabilidad, y
 * produce su propio movimiento REFUND en el libro mayor. Inmutable.
 */
export class Refund {
  readonly id: RefundId;
  readonly debitId: DebitId;
  readonly sagaId: SagaId;
  readonly fleetId: FleetId;
  readonly amount: Money;
  readonly reason: RefundReason;
  readonly audit: OperationAudit;
  readonly createdAt: Date;

  private constructor(props: Omit<Refund, never>) {
    this.id = props.id;
    this.debitId = props.debitId;
    this.sagaId = props.sagaId;
    this.fleetId = props.fleetId;
    this.amount = props.amount;
    this.reason = props.reason;
    this.audit = props.audit;
    this.createdAt = props.createdAt;
  }

  /** Reembolsa el importe completo del débito. */
  static of(debit: Debit, reason: RefundReason, audit: OperationAudit, now: Date): Refund {
    return new Refund({
      id: RefundId.forDebit(debit.id),
      debitId: debit.id,
      sagaId: debit.terms.sagaId,
      fleetId: debit.terms.fleetId,
      amount: debit.amount,
      reason,
      audit,
      createdAt: now,
    });
  }

  static restore(props: Omit<Refund, never>): Refund {
    return new Refund(props);
  }
}
