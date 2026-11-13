import {
  Debit,
  DebitId,
  DebitTombstone,
  Energy,
  FleetId,
  Money,
  OperationAudit,
  RefundId,
  SagaId,
  TopUp,
  TopUpId,
  Wallet,
  WalletTransaction,
  type DebitStatus,
  type Refund,
  type RefundReason,
  type WalletTransactionReference,
  type WalletTransactionType,
} from '../../domain/index.ts';
import { ENTITY, keys } from './table.ts';

/** Forma de los ítems en DynamoDB: importes en enteros (unidades menores), fechas ISO UTC. */

interface AuditFields {
  correlationId: string;
  idempotencyKey: string;
}

export interface WalletItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.wallet;
  fleetId: string;
  balanceMinor: number;
  currency: string;
  version: number;
  updatedAt: string;
}

export interface LedgerItem extends AuditFields {
  PK: string;
  SK: string;
  entity: typeof ENTITY.ledgerEntry;
  transactionId: string;
  fleetId: string;
  type: WalletTransactionType;
  amountMinor: number;
  balanceAfterMinor: number;
  currency: string;
  operationId: string;
  sagaId?: string;
  debitId?: string;
  refundId?: string;
  topUpId?: string;
  occurredAt: string;
  GSI1PK?: string;
  GSI1SK?: string;
}

export interface DebitItem extends AuditFields {
  PK: string;
  SK: string;
  entity: typeof ENTITY.debit;
  debitId: string;
  sagaId: string;
  fleetId: string;
  energyWh: number;
  connectorPowerKw: number;
  amountMinor: number;
  currency: string;
  tariffMinorPerKwh: number;
  surgeMultiplierBasisPoints: number;
  surgeApplied: boolean;
  status: DebitStatus;
  refundId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  GSI1PK: string;
  GSI1SK: string;
}

export interface DebitTombstoneItem extends AuditFields {
  PK: string;
  SK: string;
  entity: typeof ENTITY.debitTombstone;
  debitId: string;
  sagaId: string;
  voidedAt: string;
  GSI1PK: string;
  GSI1SK: string;
}

export interface RefundItem extends AuditFields {
  PK: string;
  SK: string;
  entity: typeof ENTITY.refund;
  refundId: string;
  debitId: string;
  sagaId: string;
  fleetId: string;
  amountMinor: number;
  currency: string;
  reason: RefundReason;
  createdAt: string;
  GSI1PK: string;
  GSI1SK: string;
}

export interface TopUpItem extends AuditFields {
  PK: string;
  SK: string;
  entity: typeof ENTITY.topUp;
  topUpId: string;
  fleetId: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
}

const auditOf = (audit: OperationAudit): AuditFields => ({
  correlationId: audit.correlationId,
  idempotencyKey: audit.idempotencyKey,
});

export function toWalletItem(wallet: Wallet, version: number): WalletItem {
  return {
    ...keys.wallet(wallet.fleetId),
    entity: ENTITY.wallet,
    fleetId: wallet.fleetId,
    balanceMinor: wallet.balance.amountMinor,
    currency: wallet.currency,
    version,
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toLedgerItem(transaction: WalletTransaction): LedgerItem {
  const occurredAt = transaction.occurredAt.toISOString();
  const reference = transaction.reference;
  const sagaId = transaction.sagaId;
  return {
    ...keys.ledgerEntry(transaction.fleetId, occurredAt, transaction.id),
    entity: ENTITY.ledgerEntry,
    transactionId: transaction.id,
    fleetId: transaction.fleetId,
    type: transaction.type,
    amountMinor: transaction.amount.amountMinor,
    balanceAfterMinor: transaction.balanceAfter.amountMinor,
    currency: transaction.amount.currency,
    operationId: transaction.operationId,
    ...(reference.type === 'TOP_UP'
      ? { topUpId: reference.topUpId }
      : { debitId: reference.debitId }),
    ...(reference.type === 'REFUND' ? { refundId: reference.refundId } : {}),
    ...(sagaId === undefined
      ? {}
      : { sagaId, GSI1PK: keys.sagaPartition(sagaId), GSI1SK: `TX#${occurredAt}` }),
    ...auditOf(transaction.audit),
    occurredAt,
  };
}

export function toDebitItem(debit: Debit, version: number): DebitItem {
  return {
    ...keys.debit(debit.id),
    entity: ENTITY.debit,
    debitId: debit.id,
    sagaId: debit.terms.sagaId,
    fleetId: debit.terms.fleetId,
    energyWh: debit.terms.energy.wattHours,
    connectorPowerKw: debit.terms.connectorPowerKw,
    amountMinor: debit.amount.amountMinor,
    currency: debit.amount.currency,
    tariffMinorPerKwh: debit.quote.tariffMinorPerKwh,
    surgeMultiplierBasisPoints: debit.quote.surgeMultiplierBasisPoints,
    surgeApplied: debit.quote.surgeApplied,
    status: debit.status,
    ...(debit.refundId === undefined ? {} : { refundId: debit.refundId }),
    ...auditOf(debit.audit),
    createdAt: debit.createdAt.toISOString(),
    updatedAt: debit.updatedAt.toISOString(),
    version,
    GSI1PK: keys.sagaPartition(debit.terms.sagaId),
    GSI1SK: `DEBIT#${debit.id}`,
  };
}

export function toDebitTombstoneItem(tombstone: DebitTombstone): DebitTombstoneItem {
  return {
    ...keys.debit(tombstone.id),
    entity: ENTITY.debitTombstone,
    debitId: tombstone.id,
    sagaId: tombstone.sagaId,
    ...auditOf(tombstone.audit),
    voidedAt: tombstone.voidedAt.toISOString(),
    GSI1PK: keys.sagaPartition(tombstone.sagaId),
    GSI1SK: `DEBIT#${tombstone.id}`,
  };
}

export function toRefundItem(refund: Refund): RefundItem {
  return {
    ...keys.refund(refund.id),
    entity: ENTITY.refund,
    refundId: refund.id,
    debitId: refund.debitId,
    sagaId: refund.sagaId,
    fleetId: refund.fleetId,
    amountMinor: refund.amount.amountMinor,
    currency: refund.amount.currency,
    reason: refund.reason,
    ...auditOf(refund.audit),
    createdAt: refund.createdAt.toISOString(),
    GSI1PK: keys.sagaPartition(refund.sagaId),
    GSI1SK: `REFUND#${refund.id}`,
  };
}

export function toTopUpItem(topUp: TopUp): TopUpItem {
  return {
    ...keys.topUp(topUp.id),
    entity: ENTITY.topUp,
    topUpId: topUp.id,
    fleetId: topUp.fleetId,
    amountMinor: topUp.amount.amountMinor,
    currency: topUp.amount.currency,
    ...auditOf(topUp.audit),
    createdAt: topUp.createdAt.toISOString(),
  };
}

export function fromWalletItem(item: WalletItem): Wallet {
  return Wallet.restore({
    fleetId: FleetId.parse(item.fleetId),
    balance: Money.of(item.balanceMinor, item.currency),
    updatedAt: new Date(item.updatedAt),
  });
}

export function fromLedgerItem(item: LedgerItem): WalletTransaction {
  const reference = ledgerReferenceOf(item);
  return WalletTransaction.record(
    {
      fleetId: FleetId.parse(item.fleetId),
      amount: Money.of(item.amountMinor, item.currency),
      balanceAfter: Money.of(item.balanceAfterMinor, item.currency),
      occurredAt: new Date(item.occurredAt),
    },
    reference,
    OperationAudit.of(item.correlationId, item.idempotencyKey),
  );
}

function ledgerReferenceOf(item: LedgerItem): WalletTransactionReference {
  const required = (value: string | undefined, field: string): string => {
    if (value === undefined) {
      throw new Error(`Movimiento ${item.transactionId} sin ${field}`);
    }
    return value;
  };
  switch (item.type) {
    case 'DEBIT':
      return {
        type: 'DEBIT',
        sagaId: SagaId.parse(required(item.sagaId, 'sagaId')),
        debitId: DebitId.parse(required(item.debitId, 'debitId')),
      };
    case 'REFUND':
      return {
        type: 'REFUND',
        sagaId: SagaId.parse(required(item.sagaId, 'sagaId')),
        debitId: DebitId.parse(required(item.debitId, 'debitId')),
        refundId: RefundId.parse(required(item.refundId, 'refundId')),
      };
    case 'TOP_UP':
      return { type: 'TOP_UP', topUpId: TopUpId.parse(required(item.topUpId, 'topUpId')) };
  }
}

export function fromDebitItem(item: DebitItem): Debit {
  return Debit.restore({
    id: DebitId.parse(item.debitId),
    terms: {
      sagaId: SagaId.parse(item.sagaId),
      fleetId: FleetId.parse(item.fleetId),
      energy: Energy.fromKwh(item.energyWh / 1000),
      connectorPowerKw: item.connectorPowerKw,
    },
    quote: {
      amount: Money.of(item.amountMinor, item.currency),
      tariffMinorPerKwh: item.tariffMinorPerKwh,
      surgeMultiplierBasisPoints: item.surgeMultiplierBasisPoints,
      surgeApplied: item.surgeApplied,
    },
    status: item.status,
    audit: OperationAudit.of(item.correlationId, item.idempotencyKey),
    ...(item.refundId === undefined ? {} : { refundId: RefundId.parse(item.refundId) }),
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
  });
}

export function fromDebitTombstoneItem(item: DebitTombstoneItem): DebitTombstone {
  return DebitTombstone.create(
    DebitId.parse(item.debitId),
    SagaId.parse(item.sagaId),
    OperationAudit.of(item.correlationId, item.idempotencyKey),
    new Date(item.voidedAt),
  );
}

export function fromTopUpItem(item: TopUpItem): TopUp {
  return TopUp.create({
    id: TopUpId.parse(item.topUpId),
    fleetId: FleetId.parse(item.fleetId),
    amount: Money.of(item.amountMinor, item.currency),
    audit: OperationAudit.of(item.correlationId, item.idempotencyKey),
    createdAt: new Date(item.createdAt),
  });
}
