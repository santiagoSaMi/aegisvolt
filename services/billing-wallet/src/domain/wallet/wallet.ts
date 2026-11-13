import { InvalidValueError } from '../shared/domain-error.ts';
import type { FleetId } from '../shared/identifiers.ts';
import { Money } from '../money/money.ts';
import { InsufficientFundsError } from './errors.ts';

export interface WalletProps {
  readonly fleetId: FleetId;
  readonly balance: Money;
  readonly updatedAt: Date;
}

/**
 * Billetera de una flota (agregado). Invariantes: el saldo nunca es negativo y
 * su moneda no cambia. Las operaciones devuelven una instancia nueva.
 */
export class Wallet {
  readonly fleetId: FleetId;
  readonly balance: Money;
  readonly updatedAt: Date;

  private constructor(props: WalletProps) {
    this.fleetId = props.fleetId;
    this.balance = props.balance;
    this.updatedAt = props.updatedAt;
  }

  static open(fleetId: FleetId, currency: string, now: Date): Wallet {
    return new Wallet({ fleetId, balance: Money.zero(currency), updatedAt: now });
  }

  static restore(props: WalletProps): Wallet {
    return new Wallet(props);
  }

  get currency(): string {
    return this.balance.currency;
  }

  canAfford(amount: Money): boolean {
    return this.balance.isGreaterThanOrEqual(amount);
  }

  debit(amount: Money, now: Date): Wallet {
    this.assertPositive(amount);
    if (!this.canAfford(amount)) {
      throw new InsufficientFundsError(
        `Saldo insuficiente: disponible ${this.balance.amountMinor}, requerido ${amount.amountMinor} ${amount.currency}`,
      );
    }
    return new Wallet({
      fleetId: this.fleetId,
      balance: this.balance.subtract(amount),
      updatedAt: now,
    });
  }

  credit(amount: Money, now: Date): Wallet {
    this.assertPositive(amount);
    return new Wallet({ fleetId: this.fleetId, balance: this.balance.add(amount), updatedAt: now });
  }

  private assertPositive(amount: Money): void {
    if (amount.isZero) {
      throw new InvalidValueError('amount', 'debe ser > 0');
    }
  }
}
