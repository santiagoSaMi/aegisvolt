import { DomainError, InvalidValueError } from '../shared/domain-error.ts';

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

/**
 * Importe en **unidades menores enteras** (p. ej. centavos de COP) para evitar
 * errores de coma flotante. Nunca negativo. Inmutable.
 */
export class Money {
  readonly amountMinor: number;
  readonly currency: string;

  private constructor(amountMinor: number, currency: string) {
    this.amountMinor = amountMinor;
    this.currency = currency;
  }

  static of(amountMinor: number, currency: string): Money {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new InvalidValueError('amountMinor', 'debe ser un entero seguro ≥ 0');
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidValueError('currency', 'debe ser un código ISO 4217');
    }
    return new Money(amountMinor, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  get isZero(): boolean {
    return this.amountMinor === 0;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor + other.amountMinor, this.currency);
  }

  /** Resta; falla si el resultado sería negativo. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (other.amountMinor > this.amountMinor) {
      throw new InvalidValueError('amountMinor', 'el resultado sería negativo');
    }
    return Money.of(this.amountMinor - other.amountMinor, this.currency);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amountMinor >= other.amountMinor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`No se pueden operar ${this.currency} y ${other.currency}`);
    }
  }
}
