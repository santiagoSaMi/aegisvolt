import type {
  Debit,
  DebitId,
  DebitTombstone,
  FleetId,
  Refund,
  TopUp,
  TopUpId,
  Wallet,
  WalletTransaction,
} from '../../domain/index.ts';

/** Valor leído junto con su versión (concurrencia optimista). */
export interface Versioned<T> {
  readonly value: T;
  readonly version: number;
}

/** Nuevo estado a escribir, condicionado a que la versión no haya cambiado. */
export interface VersionedUpdate<T> {
  readonly value: T;
  readonly expectedVersion: number;
}

export type StoredDebit =
  | { readonly kind: 'DEBIT'; readonly debit: Versioned<Debit> }
  | { readonly kind: 'TOMBSTONE'; readonly tombstone: DebitTombstone };

export interface TransactionPage {
  readonly items: readonly WalletTransaction[];
  /** Cursor opaco para la página siguiente (si hay más). */
  readonly nextCursor?: string;
}

/**
 * Persistencia de billing-wallet (tabla `aegisvolt-billing-<env>`, solo de este
 * servicio). Cada `save*` es UNA transacción: saldo + operación + movimiento del
 * libro mayor. Si una condición falla lanza `ConcurrentModificationError` y no se
 * escribe nada.
 */
export interface WalletRepository {
  findWallet(fleetId: FleetId): Promise<Versioned<Wallet> | undefined>;
  findDebit(debitId: DebitId): Promise<StoredDebit | undefined>;
  findTopUp(topUpId: TopUpId): Promise<TopUp | undefined>;
  /** Movimiento de una operación ya aplicada (para responder a un replay). */
  findTransaction(transaction: {
    fleetId: FleetId;
    id: WalletTransaction['id'];
    occurredAt: Date;
  }): Promise<WalletTransaction | undefined>;
  listTransactions(
    fleetId: FleetId,
    page: { limit: number; cursor?: string },
  ): Promise<TransactionPage>;

  /** Alta de billetera; falla si ya existe. */
  createWallet(wallet: Wallet): Promise<void>;
  /** Débito aplicado: saldo − importe (nunca negativo) + débito + movimiento DEBIT. */
  saveDebit(input: {
    wallet: VersionedUpdate<Wallet>;
    debit: Debit;
    transaction: WalletTransaction;
  }): Promise<void>;
  /** Débito rechazado por fondos: solo el registro del débito (sin movimiento). */
  saveRejectedDebit(debit: Debit): Promise<void>;
  /** Reembolso: débito → REFUNDED + Refund + saldo + movimiento REFUND. */
  saveRefund(input: {
    wallet: VersionedUpdate<Wallet>;
    debit: VersionedUpdate<Debit>;
    refund: Refund;
    transaction: WalletTransaction;
  }): Promise<void>;
  saveDebitTombstone(tombstone: DebitTombstone): Promise<void>;
  /** Recarga: saldo + TopUp + movimiento TOP_UP. */
  saveTopUp(input: {
    wallet: VersionedUpdate<Wallet>;
    topUp: TopUp;
    transaction: WalletTransaction;
  }): Promise<void>;
}
