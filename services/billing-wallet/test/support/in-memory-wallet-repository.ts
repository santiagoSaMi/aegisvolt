import {
  ConcurrentModificationError,
  InvalidCursorError,
  type StoredDebit,
  type TransactionPage,
  type Versioned,
  type VersionedUpdate,
  type WalletRepository,
} from '../../src/application/index.ts';
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
} from '../../src/domain/index.ts';

/**
 * Doble del repositorio DynamoDB con las MISMAS condiciones: versión y moneda de
 * la billetera, `saldo ≥ importe` en débitos, ids nuevos (`attribute_not_exists`)
 * y `status = DEBITED` en reembolsos. Las escrituras son todo o nada y las
 * operaciones ceden el control, así que las ejecuciones concurrentes se intercalan.
 */
export class InMemoryWalletRepository implements WalletRepository {
  readonly wallets = new Map<string, Versioned<Wallet>>();
  readonly debits = new Map<string, StoredDebit>();
  readonly refunds = new Map<string, Refund>();
  readonly topUps = new Map<string, TopUp>();
  readonly ledger: WalletTransaction[] = [];
  writes = 0;
  failNextWrites = 0;

  async findWallet(fleetId: FleetId) {
    await tick();
    return this.wallets.get(fleetId);
  }

  async findDebit(debitId: DebitId) {
    await tick();
    return this.debits.get(debitId);
  }

  async findTopUp(topUpId: TopUpId) {
    await tick();
    return this.topUps.get(topUpId);
  }

  async findTransaction(transaction: { fleetId: FleetId; id: WalletTransaction['id'] }) {
    await tick();
    return this.ledger.find(
      (entry) => entry.id === transaction.id && entry.fleetId === transaction.fleetId,
    );
  }

  async listTransactions(
    fleetId: FleetId,
    page: { limit: number; cursor?: string },
  ): Promise<TransactionPage> {
    await tick();
    const all = this.ledger
      .filter((entry) => entry.fleetId === fleetId)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id));
    let start = 0;
    if (page.cursor !== undefined) {
      start = all.findIndex((entry) => entry.id === page.cursor) + 1;
      if (start === 0) {
        throw new InvalidCursorError('cursor de paginación inválido');
      }
    }
    const items = all.slice(start, start + page.limit);
    const last = items.at(-1);
    return start + page.limit < all.length && last !== undefined
      ? { items, nextCursor: last.id }
      : { items };
  }

  async createWallet(wallet: Wallet): Promise<void> {
    await tick();
    this.beginWrite();
    if (this.wallets.has(wallet.fleetId)) {
      throw new ConcurrentModificationError('wallet exists');
    }
    this.wallets.set(wallet.fleetId, { value: wallet, version: 1 });
  }

  async saveDebit(input: {
    wallet: VersionedUpdate<Wallet>;
    debit: Debit;
    transaction: WalletTransaction;
  }): Promise<void> {
    await tick();
    this.beginWrite();
    this.assertWallet(input.wallet, input.debit.amount.amountMinor);
    this.assertNewDebit(input.debit.id);
    this.applyWallet(input.wallet);
    this.debits.set(input.debit.id, { kind: 'DEBIT', debit: { value: input.debit, version: 1 } });
    this.ledger.push(input.transaction);
  }

  async saveRejectedDebit(debit: Debit): Promise<void> {
    await tick();
    this.beginWrite();
    this.assertNewDebit(debit.id);
    this.debits.set(debit.id, { kind: 'DEBIT', debit: { value: debit, version: 1 } });
  }

  async saveRefund(input: {
    wallet: VersionedUpdate<Wallet>;
    debit: VersionedUpdate<Debit>;
    refund: Refund;
    transaction: WalletTransaction;
  }): Promise<void> {
    await tick();
    this.beginWrite();
    const stored = this.debits.get(input.debit.value.id);
    if (
      stored?.kind !== 'DEBIT' ||
      stored.debit.value.status !== 'DEBITED' ||
      stored.debit.version !== input.debit.expectedVersion
    ) {
      throw new ConcurrentModificationError('debit');
    }
    if (this.refunds.has(input.refund.id)) {
      throw new ConcurrentModificationError('refund exists');
    }
    this.assertWallet(input.wallet);
    this.applyWallet(input.wallet);
    this.debits.set(input.debit.value.id, {
      kind: 'DEBIT',
      debit: { value: input.debit.value, version: input.debit.expectedVersion + 1 },
    });
    this.refunds.set(input.refund.id, input.refund);
    this.ledger.push(input.transaction);
  }

  async saveDebitTombstone(tombstone: DebitTombstone): Promise<void> {
    await tick();
    this.beginWrite();
    this.assertNewDebit(tombstone.id);
    this.debits.set(tombstone.id, { kind: 'TOMBSTONE', tombstone });
  }

  async saveTopUp(input: {
    wallet: VersionedUpdate<Wallet>;
    topUp: TopUp;
    transaction: WalletTransaction;
  }): Promise<void> {
    await tick();
    this.beginWrite();
    this.assertWallet(input.wallet);
    if (this.topUps.has(input.topUp.id)) {
      throw new ConcurrentModificationError('top-up exists');
    }
    this.applyWallet(input.wallet);
    this.topUps.set(input.topUp.id, input.topUp);
    this.ledger.push(input.transaction);
  }

  balanceOf(fleetId: string): number | undefined {
    return this.wallets.get(fleetId)?.value.balance.amountMinor;
  }

  private beginWrite(): void {
    this.writes++;
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw new ConcurrentModificationError('forced');
    }
  }

  private assertWallet(update: VersionedUpdate<Wallet>, requiredAmountMinor?: number): void {
    const stored = this.wallets.get(update.value.fleetId);
    if (
      stored?.version !== update.expectedVersion ||
      stored.value.currency !== update.value.currency ||
      (requiredAmountMinor !== undefined && stored.value.balance.amountMinor < requiredAmountMinor)
    ) {
      throw new ConcurrentModificationError('wallet');
    }
  }

  private assertNewDebit(debitId: string): void {
    if (this.debits.has(debitId)) {
      throw new ConcurrentModificationError('debit exists');
    }
  }

  private applyWallet(update: VersionedUpdate<Wallet>): void {
    this.wallets.set(update.value.fleetId, {
      value: update.value,
      version: update.expectedVersion + 1,
    });
  }
}

/** Cede el control al event loop (simula la latencia de red). */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class FixedClock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
