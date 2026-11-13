import { InvalidValueError } from './domain-error.ts';

declare const brand: unique symbol;
type Brand<TValue, TName extends string> = TValue & { readonly [brand]: TName };

export type FleetId = Brand<string, 'FleetId'>;
export type SagaId = Brand<string, 'SagaId'>;
export type DebitId = Brand<string, 'DebitId'>;
export type TopUpId = Brand<string, 'TopUpId'>;
export type WalletTransactionId = Brand<string, 'WalletTransactionId'>;
export type RefundId = Brand<string, 'RefundId'>;

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
export const RefundId = {
  parse: (raw: string): RefundId => {
    assertId('rfd', 'refundId', raw);
    return raw as RefundId;
  },
  /**
   * El reembolso de un débito tiene un id determinista (`rfd_<valor del débito>`):
   * un débito solo puede reembolsarse una vez y el id lo hace explícito.
   */
  forDebit: (debitId: DebitId): RefundId => RefundId.parse(`rfd_${valueOf(debitId)}`),
};

export type LedgerOperationKind = 'debit' | 'refund' | 'topup';

export const WalletTransactionId = {
  parse: (raw: string): WalletTransactionId => {
    assertId('wtx', 'transactionId', raw);
    return raw as WalletTransactionId;
  },
  /**
   * Id del movimiento derivado de la operación que lo origina
   * (`wtx_debit-<valor>`): cada operación produce exactamente un movimiento.
   */
  forOperation: (kind: LedgerOperationKind, operationId: string): WalletTransactionId =>
    WalletTransactionId.parse(`wtx_${kind}-${valueOf(operationId)}`),
};

/** Parte del id tras el prefijo (`dbt_abc` → `abc`). */
function valueOf(id: string): string {
  return id.slice(id.indexOf('_') + 1);
}
