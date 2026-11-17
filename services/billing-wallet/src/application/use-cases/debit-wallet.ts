import {
  DebitId,
  Energy,
  FleetId,
  InsufficientFundsError,
  OperationAudit,
  SagaId,
  debitEstimatedCharge,
  type Debit,
  type DebitTerms,
  type PricingPolicy,
} from '../../domain/index.ts';
import { WalletNotFoundError } from '../errors.ts';
import { withOptimisticRetry } from '../optimistic-retry.ts';
import type { WalletRepository } from '../ports/repositories.ts';
import type { Clock, FeatureFlagReader, RequestAudit } from '../ports/services.ts';

export interface DebitWalletCommand {
  /** Id del débito = clave idempotente del recurso. */
  readonly debitId: string;
  readonly sagaId: string;
  readonly fleetId: string;
  readonly energyKwh: number;
  readonly connectorPowerKw: number;
  readonly audit: RequestAudit;
}

export interface DebitWalletResult {
  /** DEBITED: se cobró ahora · REPLAYED: repetición idempotente (no vuelve a cobrar). */
  readonly outcome: 'DEBITED' | 'REPLAYED';
  readonly debit: Debit;
}

/**
 * Cobra el importe estimado de una carga (paso 2 de la SAGA).
 *
 * - El importe lo calcula la política de precios; el cliente no lo define.
 * - Atomicidad: saldo, débito y movimiento DEBIT en una transacción condicionada
 *   a la versión leída de la billetera y a `saldo ≥ importe` (nunca negativo).
 * - Concurrencia: si otra operación cambió la billetera, se relee y se decide de
 *   nuevo (puede terminar en fondos insuficientes).
 * - Fondos insuficientes: se registra el débito RECHAZADO (auditable) y se lanza
 *   `InsufficientFundsError`; un reintento con la misma clave da el mismo 422.
 */
export class DebitWallet {
  private readonly wallets: WalletRepository;
  private readonly pricing: PricingPolicy;
  private readonly flags: FeatureFlagReader;
  private readonly clock: Clock;

  constructor(deps: {
    wallets: WalletRepository;
    pricing: PricingPolicy;
    flags: FeatureFlagReader;
    clock: Clock;
  }) {
    this.wallets = deps.wallets;
    this.pricing = deps.pricing;
    this.flags = deps.flags;
    this.clock = deps.clock;
  }

  async execute(command: DebitWalletCommand): Promise<DebitWalletResult> {
    const debitId = DebitId.parse(command.debitId);
    const terms: DebitTerms = {
      sagaId: SagaId.parse(command.sagaId),
      fleetId: FleetId.parse(command.fleetId),
      energy: Energy.fromKwh(command.energyKwh),
      connectorPowerKw: command.connectorPowerKw,
    };
    const audit = OperationAudit.of(command.audit.correlationId, command.audit.idempotencyKey);

    const result = await withOptimisticRetry(() => this.attempt(debitId, terms, audit));
    // Un rechazo (nuevo o repetido) siempre se informa igual: 422 INSUFFICIENT_FUNDS.
    if (result.outcome === 'REJECTED' || result.debit.status === 'REJECTED_INSUFFICIENT_FUNDS') {
      throw new InsufficientFundsError(
        `Saldo insuficiente para ${result.debit.amount.amountMinor} ${result.debit.amount.currency} (débito ${debitId})`,
      );
    }
    return { outcome: result.outcome, debit: result.debit };
  }

  private async attempt(
    debitId: DebitId,
    terms: DebitTerms,
    audit: OperationAudit,
  ): Promise<{ outcome: 'DEBITED' | 'REPLAYED' | 'REJECTED'; debit: Debit }> {
    const now = this.clock.now();
    const [wallet, stored] = await Promise.all([
      this.wallets.findWallet(terms.fleetId),
      this.wallets.findDebit(debitId),
    ]);
    if (wallet === undefined) {
      throw new WalletNotFoundError(`No existe la billetera de ${terms.fleetId}`);
    }
    const result = debitEstimatedCharge({
      debitId,
      terms,
      wallet: wallet.value,
      existing: stored?.kind === 'DEBIT' ? stored.debit.value : undefined,
      tombstone: stored?.kind === 'TOMBSTONE' ? stored.tombstone : undefined,
      pricing: this.pricing,
      surgePricingEnabled: await this.flags.isEnabled('ENABLE_DYNAMIC_SURGE_PRICING'),
      audit,
      now,
    });

    switch (result.kind) {
      case 'REPLAYED':
        return { outcome: 'REPLAYED', debit: result.debit };
      case 'REJECTED_INSUFFICIENT_FUNDS':
        await this.wallets.saveRejectedDebit(result.debit);
        return { outcome: 'REJECTED', debit: result.debit };
      case 'DEBITED':
        await this.wallets.saveDebit({
          wallet: { value: result.wallet, expectedVersion: wallet.version },
          debit: result.debit,
          transaction: result.transaction,
        });
        return { outcome: 'DEBITED', debit: result.debit };
    }
  }
}
