import {
  DebitId,
  OperationAudit,
  RefundId,
  SagaId,
  refundDebit,
  type Debit,
  type RefundReason,
} from '../../domain/index.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { WalletRepository } from '../ports/repositories.ts';
import type { Clock, RequestAudit } from '../ports/services.ts';

export interface RefundWalletCommand {
  readonly debitId: string;
  /** SAGA que pide la compensación (`x-saga-id`): debe ser la dueña del débito. */
  readonly sagaId: string;
  readonly reason: RefundReason;
  /** Sin `idempotencyKey` explícita se registra el id determinista del reembolso. */
  readonly audit: Pick<RequestAudit, 'correlationId'> &
    Partial<Pick<RequestAudit, 'idempotencyKey'>>;
}

export type RefundWalletResult =
  | {
      readonly outcome: 'REFUNDED' | 'ALREADY_REFUNDED' | 'NOTHING_TO_REFUND';
      readonly debit: Debit;
      readonly refundId: RefundId | undefined;
    }
  | { readonly outcome: 'VOIDED'; readonly debitId: DebitId };

/**
 * Compensación: reembolsa un débito como operación de negocio propia (Refund
 * con id `rfd_…`, motivo, auditoría y movimiento REFUND).
 *
 * - No reembolsa dos veces: la transacción exige `status = DEBITED` y la versión
 *   leída del débito, y el Refund se crea con `attribute_not_exists`.
 * - Atomicidad: débito, Refund, saldo y movimiento en una sola transacción.
 * - Débito inexistente: tombstone (VOIDED) que bloquea un cobro tardío.
 */
export class RefundWallet {
  private readonly wallets: WalletRepository;
  private readonly clock: Clock;

  constructor(deps: { wallets: WalletRepository; clock: Clock }) {
    this.wallets = deps.wallets;
    this.clock = deps.clock;
  }

  execute(command: RefundWalletCommand): Promise<RefundWalletResult> {
    const debitId = DebitId.parse(command.debitId);
    const requestedBy = SagaId.parse(command.sagaId);
    const audit = OperationAudit.of(
      command.audit.correlationId,
      command.audit.idempotencyKey ?? RefundId.forDebit(debitId),
    );
    return withOptimisticRetry(() => this.attempt(debitId, requestedBy, command.reason, audit));
  }

  private async attempt(
    debitId: DebitId,
    requestedBy: SagaId,
    reason: RefundReason,
    audit: OperationAudit,
  ): Promise<RefundWalletResult> {
    const now = this.clock.now();
    const stored = await this.wallets.findDebit(debitId);
    if (stored?.kind === 'TOMBSTONE') {
      return { outcome: 'VOIDED', debitId };
    }
    const debit = stored?.debit;
    const wallet =
      debit === undefined ? undefined : await this.wallets.findWallet(debit.value.terms.fleetId);

    const result = refundDebit({
      debitId,
      requestedBy,
      debit: debit?.value,
      wallet: wallet?.value,
      reason,
      audit,
      now,
    });

    switch (result.outcome) {
      case 'VOIDED':
        await this.wallets.saveDebitTombstone(result.tombstone);
        return { outcome: 'VOIDED', debitId };
      case 'ALREADY_REFUNDED':
      case 'NOTHING_TO_REFUND':
        return { outcome: result.outcome, debit: result.debit, refundId: result.debit.refundId };
      case 'REFUNDED':
        if (debit === undefined || wallet === undefined) {
          throw new Error('Estado inconsistente: reembolso sin débito o billetera leídos');
        }
        await this.wallets.saveRefund({
          wallet: { value: result.wallet, expectedVersion: wallet.version },
          debit: { value: result.debit, expectedVersion: debit.version },
          refund: result.refund,
          transaction: result.transaction,
        });
        return { outcome: 'REFUNDED', debit: result.debit, refundId: result.refund.id };
    }
  }
}
