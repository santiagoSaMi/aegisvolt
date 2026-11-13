import { billingWalletV1 } from '@aegisvolt/contracts';
import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  DEBIT_STATUSES,
  DebitTermsMismatchError,
  DebitVoidedError,
  InsufficientFundsError,
  WALLET_TRANSACTION_TYPES,
} from '../../src/domain/index.ts';

/** El dominio no importa el contrato; esta prueba evita que diverjan. */
describe('alineación dominio ↔ contrato billing-wallet v1', () => {
  it('vocabulario: el contrato añade VOIDED para los tombstones', () => {
    expect([...DEBIT_STATUSES, 'VOIDED'].sort()).toEqual(
      [...billingWalletV1.DEBIT_STATUSES].sort(),
    );
    expect([...WALLET_TRANSACTION_TYPES]).toEqual([...billingWalletV1.WALLET_TRANSACTION_TYPES]);
  });

  it('cada error de negocio del dominio tiene su código en el catálogo HTTP', () => {
    const errors = [
      new InsufficientFundsError('x'),
      new CurrencyMismatchError('x'),
      new DebitVoidedError('x'),
      new DebitTermsMismatchError('x'),
    ];
    for (const error of errors) {
      expect(billingWalletV1.ERROR_CODES).toHaveProperty(error.code);
    }
  });
});
