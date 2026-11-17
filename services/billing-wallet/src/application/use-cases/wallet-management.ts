import {
  FleetId,
  Money,
  OperationAudit,
  TopUpId,
  Wallet,
  WalletTransactionId,
  topUpWallet,
  type WalletTransaction,
} from '../../domain/index.ts';
import { ConcurrentModificationError, WalletNotFoundError } from '../errors.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { WalletRepository } from '../ports/repositories.ts';
import type { Clock, RequestAudit } from '../ports/services.ts';

/**
 * Abre la billetera de una flota con saldo 0 en la moneda configurada del
 * servicio. Idempotente: si ya existe la devuelve. El cliente nunca fija el saldo.
 */
export class OpenWallet {
  private readonly wallets: WalletRepository;
  private readonly clock: Clock;
  private readonly currency: string;

  constructor(deps: { wallets: WalletRepository; clock: Clock; currency: string }) {
    this.wallets = deps.wallets;
    this.clock = deps.clock;
    this.currency = deps.currency;
  }

  async execute(fleetId: string): Promise<{ outcome: 'CREATED' | 'EXISTING'; wallet: Wallet }> {
    const id = FleetId.parse(fleetId);
    const existing = await this.wallets.findWallet(id);
    if (existing !== undefined) {
      return { outcome: 'EXISTING', wallet: existing.value };
    }
    const wallet = Wallet.open(id, this.currency, this.clock.now());
    try {
      await this.wallets.createWallet(wallet);
      return { outcome: 'CREATED', wallet };
    } catch (error) {
      const raced =
        error instanceof ConcurrentModificationError
          ? await this.wallets.findWallet(id)
          : undefined;
      if (raced === undefined) {
        throw error;
      }
      return { outcome: 'EXISTING', wallet: raced.value };
    }
  }
}

export interface TopUpWalletCommand {
  readonly fleetId: string;
  readonly topUpId: string;
  readonly amount: { readonly amountMinor: number; readonly currency: string };
  readonly audit: RequestAudit;
}

/** Recarga administrativa (idempotente por `topUpId`): saldo + TopUp + movimiento TOP_UP. */
export class TopUpWallet {
  private readonly wallets: WalletRepository;
  private readonly clock: Clock;

  constructor(deps: { wallets: WalletRepository; clock: Clock }) {
    this.wallets = deps.wallets;
    this.clock = deps.clock;
  }

  execute(
    command: TopUpWalletCommand,
  ): Promise<{ outcome: 'APPLIED' | 'REPLAYED'; wallet: Wallet; transaction: WalletTransaction }> {
    const fleetId = FleetId.parse(command.fleetId);
    const topUpId = TopUpId.parse(command.topUpId);
    const amount = Money.of(command.amount.amountMinor, command.amount.currency);
    const audit = OperationAudit.of(command.audit.correlationId, command.audit.idempotencyKey);

    return withOptimisticRetry(async () => {
      const now = this.clock.now();
      const [wallet, existing] = await Promise.all([
        this.wallets.findWallet(fleetId),
        this.wallets.findTopUp(topUpId),
      ]);
      if (wallet === undefined) {
        throw new WalletNotFoundError(`No existe la billetera de ${fleetId}`);
      }
      const result = topUpWallet({ topUpId, wallet: wallet.value, amount, existing, audit, now });
      if (result.kind === 'REPLAYED') {
        const transaction = await this.wallets.findTransaction({
          fleetId,
          id: WalletTransactionId.forOperation('topup', topUpId),
          occurredAt: result.topUp.createdAt,
        });
        if (transaction === undefined) {
          throw new Error(`Recarga ${topUpId} sin movimiento en el libro mayor`);
        }
        return { outcome: 'REPLAYED', wallet: wallet.value, transaction };
      }
      await this.wallets.saveTopUp({
        wallet: { value: result.wallet, expectedVersion: wallet.version },
        topUp: result.topUp,
        transaction: result.transaction,
      });
      return { outcome: 'APPLIED', wallet: result.wallet, transaction: result.transaction };
    });
  }
}
