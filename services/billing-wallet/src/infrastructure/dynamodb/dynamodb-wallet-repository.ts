import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import {
  InvalidCursorError,
  type StoredDebit,
  type TransactionPage,
  type Versioned,
  type VersionedUpdate,
  type WalletRepository,
} from '../../application/index.ts';
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
import { dynamo } from './errors.ts';
import {
  fromDebitItem,
  fromDebitTombstoneItem,
  fromLedgerItem,
  fromTopUpItem,
  fromWalletItem,
  toDebitItem,
  toDebitTombstoneItem,
  toLedgerItem,
  toRefundItem,
  toTopUpItem,
  toWalletItem,
  type DebitItem,
  type DebitTombstoneItem,
  type LedgerItem,
  type TopUpItem,
  type WalletItem,
} from './mappers.ts';
import { ENTITY, keys } from './table.ts';

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

const NEW_ITEM = 'attribute_not_exists(PK)';

/**
 * Billeteras, operaciones y libro mayor en `aegisvolt-billing-<env>`.
 *
 * Cada operación financiera es UNA transacción con condiciones explícitas:
 * - billetera: versión leída + moneda + (en débitos) `balanceMinor >= :amount`
 *   → el saldo nunca queda negativo ni se pierde una actualización concurrente;
 * - operación (débito, reembolso, recarga) y movimiento del libro mayor:
 *   `attribute_not_exists(PK)` → cada operación se aplica y se registra una sola vez;
 * - reembolso: el débito debe seguir `DEBITED` en la versión leída → nunca dos veces.
 * Si una condición falla, no se escribe nada (todo o nada).
 */
export class DynamoDbWalletRepository implements WalletRepository {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(db: DynamoDBDocumentClient, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  async findWallet(fleetId: FleetId): Promise<Versioned<Wallet> | undefined> {
    const item = await this.get<WalletItem>(keys.wallet(fleetId));
    return item === undefined ? undefined : { value: fromWalletItem(item), version: item.version };
  }

  async findDebit(debitId: DebitId): Promise<StoredDebit | undefined> {
    const item = await this.get<DebitItem | DebitTombstoneItem>(keys.debit(debitId));
    if (item === undefined) {
      return undefined;
    }
    if (item.entity === ENTITY.debitTombstone) {
      return { kind: 'TOMBSTONE', tombstone: fromDebitTombstoneItem(item) };
    }
    return { kind: 'DEBIT', debit: { value: fromDebitItem(item), version: item.version } };
  }

  async findTopUp(topUpId: TopUpId): Promise<TopUp | undefined> {
    const item = await this.get<TopUpItem>(keys.topUp(topUpId));
    return item === undefined ? undefined : fromTopUpItem(item);
  }

  async findTransaction(transaction: {
    fleetId: FleetId;
    id: WalletTransaction['id'];
    occurredAt: Date;
  }): Promise<WalletTransaction | undefined> {
    const item = await this.get<LedgerItem>(
      keys.ledgerEntry(transaction.fleetId, transaction.occurredAt.toISOString(), transaction.id),
    );
    return item === undefined ? undefined : fromLedgerItem(item);
  }

  async listTransactions(
    fleetId: FleetId,
    page: { limit: number; cursor?: string },
  ): Promise<TransactionPage> {
    const partition = keys.walletPartition(fleetId);
    const startKey = page.cursor === undefined ? undefined : decodeCursor(page.cursor, partition);
    const result = await dynamo(() =>
      this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tx)',
          ExpressionAttributeValues: { ':pk': partition, ':tx': keys.ledgerPrefix },
          ScanIndexForward: false,
          Limit: page.limit,
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      ),
    );
    const items = ((result.Items ?? []) as LedgerItem[]).map(fromLedgerItem);
    const last = result.LastEvaluatedKey;
    return last === undefined ? { items } : { items, nextCursor: encodeCursor(last) };
  }

  async createWallet(wallet: Wallet): Promise<void> {
    await dynamo(() =>
      this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toWalletItem(wallet, 1),
          ConditionExpression: NEW_ITEM,
        }),
      ),
    );
  }

  async saveDebit(input: {
    wallet: VersionedUpdate<Wallet>;
    debit: Debit;
    transaction: WalletTransaction;
  }): Promise<void> {
    await this.transact([
      this.walletUpdate(input.wallet, {
        expression: 'balanceMinor >= :amount',
        values: { ':amount': input.debit.amount.amountMinor },
      }),
      this.put(toDebitItem(input.debit, 1)),
      this.put(toLedgerItem(input.transaction)),
    ]);
  }

  async saveRejectedDebit(debit: Debit): Promise<void> {
    await this.transact([this.put(toDebitItem(debit, 1))]);
  }

  async saveRefund(input: {
    wallet: VersionedUpdate<Wallet>;
    debit: VersionedUpdate<Debit>;
    refund: Refund;
    transaction: WalletTransaction;
  }): Promise<void> {
    const debit = input.debit.value;
    await this.transact([
      {
        Update: {
          TableName: this.tableName,
          Key: keys.debit(debit.id),
          UpdateExpression:
            'SET #status = :refunded, refundId = :refundId, updatedAt = :updatedAt, #version = :nextVersion',
          // Un débito solo se reembolsa desde DEBITED y en la versión leída.
          ConditionExpression: '#status = :debited AND #version = :expectedVersion',
          ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
          ExpressionAttributeValues: {
            ':refunded': debit.status,
            ':debited': 'DEBITED',
            ':refundId': input.refund.id,
            ':updatedAt': debit.updatedAt.toISOString(),
            ':nextVersion': input.debit.expectedVersion + 1,
            ':expectedVersion': input.debit.expectedVersion,
          },
        },
      },
      this.put(toRefundItem(input.refund)),
      this.walletUpdate(input.wallet),
      this.put(toLedgerItem(input.transaction)),
    ]);
  }

  async saveDebitTombstone(tombstone: DebitTombstone): Promise<void> {
    await this.transact([this.put(toDebitTombstoneItem(tombstone))]);
  }

  async saveTopUp(input: {
    wallet: VersionedUpdate<Wallet>;
    topUp: TopUp;
    transaction: WalletTransaction;
  }): Promise<void> {
    await this.transact([
      this.walletUpdate(input.wallet),
      this.put(toTopUpItem(input.topUp)),
      this.put(toLedgerItem(input.transaction)),
    ]);
  }

  /** Nuevo saldo condicionado a versión y moneda (+ condición extra, p. ej. fondos). */
  private walletUpdate(
    update: VersionedUpdate<Wallet>,
    extra?: { expression: string; values: Record<string, number> },
  ): TransactItem {
    const wallet = update.value;
    return {
      Update: {
        TableName: this.tableName,
        Key: keys.wallet(wallet.fleetId),
        UpdateExpression:
          'SET balanceMinor = :balance, updatedAt = :updatedAt, #version = :nextVersion',
        ConditionExpression: [
          'attribute_exists(PK)',
          '#version = :expectedVersion',
          'currency = :currency',
          ...(extra === undefined ? [] : [extra.expression]),
        ].join(' AND '),
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':balance': wallet.balance.amountMinor,
          ':currency': wallet.currency,
          ':updatedAt': wallet.updatedAt.toISOString(),
          ':nextVersion': update.expectedVersion + 1,
          ':expectedVersion': update.expectedVersion,
          ...extra?.values,
        },
      },
    };
  }

  private put(item: object): TransactItem {
    return {
      Put: {
        TableName: this.tableName,
        Item: item as Record<string, unknown>,
        ConditionExpression: NEW_ITEM,
      },
    };
  }

  private async get<T>(key: { PK: string; SK: string }): Promise<T | undefined> {
    const { Item } = await dynamo(() =>
      this.db.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true })),
    );
    return Item as T | undefined;
  }

  private async transact(items: TransactItem[]): Promise<void> {
    await dynamo(() => this.db.send(new TransactWriteCommand({ TransactItems: items })));
  }
}

/** Cursor opaco: clave de la última fila (base64url), validado contra la partición. */
function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor: string, partition: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof key === 'object' &&
      key !== null &&
      (key as Record<string, unknown>).PK === partition &&
      typeof (key as Record<string, unknown>).SK === 'string'
    ) {
      return key as Record<string, unknown>;
    }
  } catch {
    // cursor ilegible
  }
  throw new InvalidCursorError('cursor de paginación inválido');
}
