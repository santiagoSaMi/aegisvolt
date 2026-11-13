import type {
  FleetId,
  SagaEvent,
  SagaId,
  SagaStatus,
  SagaTransaction,
} from '../../domain/index.ts';

/** Valor leído junto con su versión (concurrencia optimista). */
export interface Versioned<T> {
  readonly value: T;
  readonly version: number;
}

/** *Lease* de ejecución: solo su dueño puede escribir la SAGA hasta que venza. */
export interface Lease {
  readonly owner: string;
  readonly expiresAt: Date;
}

/**
 * Persistencia del orquestador (`aegisvolt-sagas-<env>`). Toda escritura de
 * estado inserta sus eventos nuevos en la MISMA transacción y está condicionada
 * a la versión leída y al *lease* del escritor; si falla, lanza
 * `ConcurrentModificationError` sin escribir nada.
 */
export interface SagaRepository {
  /** Crea la SAGA (id nuevo) con el *lease* del creador; versión 1. */
  create(saga: SagaTransaction, lease: Lease): Promise<void>;
  find(sagaId: SagaId): Promise<Versioned<SagaTransaction> | undefined>;
  /** Guarda el nuevo estado desde `expectedVersion`, renovando el *lease*. Devuelve la versión nueva. */
  save(saga: SagaTransaction, expectedVersion: number, lease: Lease): Promise<number>;
  /** Toma el *lease* si está libre, vencido o ya es de `lease.owner`. */
  acquireLease(sagaId: SagaId, lease: Lease, now: Date): Promise<boolean>;
  releaseLease(sagaId: SagaId, owner: string): Promise<void>;
  listEvents(sagaId: SagaId): Promise<readonly SagaEvent[]>;
  listByFleet(
    fleetId: FleetId,
    query: { status?: SagaStatus | undefined; limit: number },
  ): Promise<readonly SagaTransaction[]>;
  /** SAGAs no terminales (candidatas a recuperación), por índice de estado. */
  listNonTerminal(limit: number): Promise<readonly Versioned<SagaTransaction>[]>;
}
