import { InvalidValueError } from './domain-error.ts';

declare const brand: unique symbol;
type Brand<TValue, TName extends string> = TValue & { readonly [brand]: TName };

export type FleetId = Brand<string, 'FleetId'>;
export type SagaId = Brand<string, 'SagaId'>;
export type DebitId = Brand<string, 'DebitId'>;
export type TopUpId = Brand<string, 'TopUpId'>;
export type WalletTransactionId = Brand<string, 'WalletTransactionId'>;

const ID_VALUE = '[a-z0-9][a-z0-9-]{0,62}';

function assertId(prefix: string, field: string, raw: string): void {
  if (!new RegExp(`^${prefix}_${ID_VALUE}$`).test(raw)) {
    throw new InvalidValueError(field, `debe tener el formato ${prefix}_<valor>`);
  }
}

export const FleetId = {
  parse: (raw: string): FleetId => {
    assertId('fleet', 'fleetId', raw);
    return raw as FleetId;
  },
};
export const SagaId = {
  parse: (raw: string): SagaId => {
    assertId('saga', 'sagaId', raw);
    return raw as SagaId;
  },
};
export const DebitId = {
  parse: (raw: string): DebitId => {
    assertId('dbt', 'debitId', raw);
    return raw as DebitId;
  },
};
export const TopUpId = {
  parse: (raw: string): TopUpId => {
    assertId('tup', 'topUpId', raw);
    return raw as TopUpId;
  },
};
export const WalletTransactionId = {
  parse: (raw: string): WalletTransactionId => {
    assertId('wtx', 'transactionId', raw);
    return raw as WalletTransactionId;
  },
};
