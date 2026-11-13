import {
  ConcurrentModificationError,
  SagaAlreadyExistsError,
  type Lease,
  type SagaRepository,
  type Versioned,
} from '../../src/application/index.ts';
import {
  SagaTransaction,
  type FleetId,
  type SagaEvent,
  type SagaId,
  type SagaStatus,
  type SagaTransactionProps,
} from '../../src/domain/index.ts';

interface Row {
  saga: SagaTransaction;
  version: number;
  lease?: Lease;
}

/**
 * Repositorio en memoria con las MISMAS condiciones que el adaptador DynamoDB:
 * creación con id nuevo, escritura con versión leída + dueño del *lease*, y toma
 * de *lease* libre/vencido/propio. Guarda copias "restauradas" (sin eventos
 * pendientes), como haría la persistencia real.
 */
export class InMemorySagaRepository implements SagaRepository {
  readonly rows = new Map<string, Row>();
  readonly events = new Map<string, SagaEvent[]>();
  /** Historial de estados persistidos por SAGA (para verificar "antes y después"). */
  readonly statusLog = new Map<string, string[]>();
  saves = 0;
  /** Se ejecuta antes de cada `save` (inyección de concurrencia o fallos). */
  beforeSave: ((saga: SagaTransaction) => void) | undefined;

  create(saga: SagaTransaction, lease: Lease): Promise<void> {
    if (this.rows.has(saga.id)) {
      return Promise.reject(new SagaAlreadyExistsError(`La SAGA ${saga.id} ya existe`));
    }
    this.store(saga, 1, lease);
    return Promise.resolve();
  }

  find(sagaId: SagaId): Promise<Versioned<SagaTransaction> | undefined> {
    const row = this.rows.get(sagaId);
    return Promise.resolve(
      row === undefined ? undefined : { value: row.saga, version: row.version },
    );
  }

  save(saga: SagaTransaction, expectedVersion: number, lease: Lease): Promise<number> {
    this.beforeSave?.(saga);
    const row = this.rows.get(saga.id);
    if (row?.version !== expectedVersion || row.lease?.owner !== lease.owner) {
      return Promise.reject(new ConcurrentModificationError('versión o lease distintos'));
    }
    this.store(saga, expectedVersion + 1, lease);
    this.saves++;
    return Promise.resolve(expectedVersion + 1);
  }

  acquireLease(sagaId: SagaId, lease: Lease, now: Date): Promise<boolean> {
    const row = this.rows.get(sagaId);
    if (row === undefined) {
      return Promise.resolve(false);
    }
    const free =
      row.lease === undefined ||
      row.lease.expiresAt.getTime() < now.getTime() ||
      row.lease.owner === lease.owner;
    if (free) {
      row.lease = lease;
    }
    return Promise.resolve(free);
  }

  releaseLease(sagaId: SagaId, owner: string): Promise<void> {
    const row = this.rows.get(sagaId);
    if (row?.lease?.owner === owner) {
      delete row.lease;
    }
    return Promise.resolve();
  }

  listEvents(sagaId: SagaId): Promise<readonly SagaEvent[]> {
    return Promise.resolve(this.events.get(sagaId) ?? []);
  }

  listByFleet(
    fleetId: FleetId,
    query: { status?: SagaStatus | undefined; limit: number },
  ): Promise<readonly SagaTransaction[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .map((row) => row.saga)
        .filter(
          (s) =>
            s.request.fleetId === fleetId &&
            (query.status === undefined || s.status === query.status),
        )
        .slice(0, query.limit),
    );
  }

  listNonTerminal(limit: number): Promise<readonly Versioned<SagaTransaction>[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => !row.saga.isTerminal)
        .slice(0, limit)
        .map((row) => ({ value: row.saga, version: row.version })),
    );
  }

  /** Simula que el proceso dueño murió: su *lease* queda vencido. */
  expireLease(sagaId: string): void {
    const row = this.rows.get(sagaId);
    if (row?.lease !== undefined) {
      row.lease = { owner: row.lease.owner, expiresAt: new Date(0) };
    }
  }

  /** Reescribe la SAGA persistida (p. ej. para retroceder `updatedAt`). */
  overwrite(sagaId: string, changes: Partial<SagaTransactionProps>): void {
    const row = this.rows.get(sagaId);
    if (row === undefined) {
      throw new Error(`No existe ${sagaId}`);
    }
    row.saga = SagaTransaction.restore({ ...propsOf(row.saga), ...changes });
  }

  private store(saga: SagaTransaction, version: number, lease: Lease): void {
    const list = this.events.get(saga.id) ?? [];
    list.push(...saga.pendingEvents);
    this.events.set(saga.id, list);
    const log = this.statusLog.get(saga.id) ?? [];
    log.push(saga.status);
    this.statusLog.set(saga.id, log);
    this.rows.set(saga.id, { saga: saga.withoutPendingEvents(), version, lease });
  }
}

function propsOf(saga: SagaTransaction): SagaTransactionProps {
  return {
    id: saga.id,
    idempotencyKey: saga.idempotencyKey,
    request: saga.request,
    resources: saga.resources,
    operationKeys: saga.operationKeys,
    correlationId: saga.correlationId,
    status: saga.status,
    steps: saga.steps,
    compensationPlan: saga.compensationPlan,
    compensationRounds: saga.compensationRounds,
    eventCount: saga.eventCount,
    createdAt: saga.createdAt,
    updatedAt: saga.updatedAt,
    ...(saga.connectorPowerKw === undefined ? {} : { connectorPowerKw: saga.connectorPowerKw }),
    ...(saga.failureReason === undefined ? {} : { failureReason: saga.failureReason }),
    ...(saga.failedStep === undefined ? {} : { failedStep: saga.failedStep }),
    ...(saga.compensationFailure === undefined
      ? {}
      : { compensationFailure: saga.compensationFailure }),
  };
}
