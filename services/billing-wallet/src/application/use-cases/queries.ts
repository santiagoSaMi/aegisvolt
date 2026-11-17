import {
  DebitId,
  Energy,
  FleetId,
  InvalidValueError,
  type Debit,
  type DebitTombstone,
  type Money,
  type PriceQuote,
  type PricingPolicy,
  type Wallet,
} from '../../domain/index.ts';
import { DebitNotFoundError, WalletNotFoundError } from '../errors.ts';
import type { TransactionPage, WalletRepository } from '../ports/repositories.ts';
import type { Clock, FeatureFlagReader } from '../ports/services.ts';

/** Saldo actual de la billetera de una flota. */
export class GetWalletBalance {
  private readonly wallets: WalletRepository;

  constructor(deps: { wallets: WalletRepository }) {
    this.wallets = deps.wallets;
  }

  async execute(fleetId: string): Promise<Wallet> {
    const id = FleetId.parse(fleetId);
    const wallet = await this.wallets.findWallet(id);
    if (wallet === undefined) {
      throw new WalletNotFoundError(`No existe la billetera de ${id}`);
    }
    return wallet.value;
  }
}

export interface FundsCheck {
  readonly wallet: Wallet;
  readonly quote: PriceQuote;
  readonly required: Money;
  readonly sufficient: boolean;
}

/**
 * Verifica si el saldo cubre el cargo estimado de una carga (consulta: no
 * retiene fondos; el débito vuelve a comprobarlo de forma atómica).
 */
export class VerifyFunds {
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

  async execute(query: {
    fleetId: string;
    energyKwh: number;
    connectorPowerKw: number;
  }): Promise<FundsCheck> {
    const wallet = await new GetWalletBalance({ wallets: this.wallets }).execute(query.fleetId);
    const quote = this.pricing.quote({
      energy: Energy.fromKwh(query.energyKwh),
      connectorPowerKw: query.connectorPowerKw,
      at: this.clock.now(),
      surgePricingEnabled: await this.flags.isEnabled('ENABLE_DYNAMIC_SURGE_PRICING'),
    });
    return { wallet, quote, required: quote.amount, sufficient: wallet.canAfford(quote.amount) };
  }
}

/** Historial de movimientos (libro mayor), del más reciente al más antiguo, paginado. */
export class GetTransactionHistory {
  static readonly MAX_LIMIT = 100;

  private readonly wallets: WalletRepository;

  constructor(deps: { wallets: WalletRepository }) {
    this.wallets = deps.wallets;
  }

  async execute(query: {
    fleetId: string;
    limit: number;
    cursor?: string;
  }): Promise<TransactionPage> {
    const fleetId = FleetId.parse(query.fleetId);
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > GetTransactionHistory.MAX_LIMIT
    ) {
      throw new InvalidValueError(
        'limit',
        `debe estar entre 1 y ${GetTransactionHistory.MAX_LIMIT}`,
      );
    }
    if ((await this.wallets.findWallet(fleetId)) === undefined) {
      throw new WalletNotFoundError(`No existe la billetera de ${fleetId}`);
    }
    return this.wallets.listTransactions(fleetId, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }
}

/** Estado de un débito (lo usa el orquestador para resolver resultados desconocidos). */
export class GetDebit {
  private readonly wallets: WalletRepository;

  constructor(deps: { wallets: WalletRepository }) {
    this.wallets = deps.wallets;
  }

  async execute(
    debitId: string,
  ): Promise<{ kind: 'DEBIT'; debit: Debit } | { kind: 'TOMBSTONE'; tombstone: DebitTombstone }> {
    const id = DebitId.parse(debitId);
    const stored = await this.wallets.findDebit(id);
    if (stored === undefined) {
      throw new DebitNotFoundError(`No existe el débito ${id}`);
    }
    return stored.kind === 'DEBIT'
      ? { kind: 'DEBIT', debit: stored.debit.value }
      : { kind: 'TOMBSTONE', tombstone: stored.tombstone };
  }
}
