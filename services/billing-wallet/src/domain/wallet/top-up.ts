import type { Money } from '../money/money.ts';
import { InvalidValueError } from '../shared/domain-error.ts';
import type { FleetId, TopUpId } from '../shared/identifiers.ts';
import type { OperationAudit } from '../shared/operation-audit.ts';

/**
 * Recarga administrativa de saldo (operación idempotente por `topUpId`).
 * No permite fijar el saldo: solo sumar un importe positivo.
 */
export class TopUp {
  readonly id: TopUpId;
  readonly fleetId: FleetId;
  readonly amount: Money;
  readonly audit: OperationAudit;
  readonly createdAt: Date;

  private constructor(props: Omit<TopUp, 'hasSameTerms'>) {
    this.id = props.id;
    this.fleetId = props.fleetId;
    this.amount = props.amount;
    this.audit = props.audit;
    this.createdAt = props.createdAt;
  }

  static create(props: Omit<TopUp, 'hasSameTerms'>): TopUp {
    if (props.amount.isZero) {
      throw new InvalidValueError('amount', 'una recarga debe ser > 0');
    }
    return new TopUp(props);
  }

  hasSameTerms(fleetId: FleetId, amount: Money): boolean {
    return this.fleetId === fleetId && this.amount.equals(amount);
  }
}
