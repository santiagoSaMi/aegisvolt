import {
  FleetId,
  SagaId,
  type SagaEvent,
  type SagaStatus,
  type SagaTransaction,
} from '../../domain/index.ts';
import { SagaNotFoundError } from '../errors.ts';
import type { SagaRepository } from '../ports/repositories.ts';

export class GetSaga {
  private readonly sagas: SagaRepository;

  constructor(deps: { sagas: SagaRepository }) {
    this.sagas = deps.sagas;
  }

  async execute(rawSagaId: string): Promise<SagaTransaction> {
    const sagaId = SagaId.parse(rawSagaId);
    const stored = await this.sagas.find(sagaId);
    if (stored === undefined) {
      throw new SagaNotFoundError(`No existe la SAGA ${sagaId}`);
    }
    return stored.value;
  }
}

/** Historial de la SAGA (panel de compensaciones del frontend, auditoría de Prefect). */
export class ListSagaEvents {
  private readonly sagas: SagaRepository;

  constructor(deps: { sagas: SagaRepository }) {
    this.sagas = deps.sagas;
  }

  async execute(
    rawSagaId: string,
  ): Promise<{ saga: SagaTransaction; events: readonly SagaEvent[] }> {
    const saga = await new GetSaga({ sagas: this.sagas }).execute(rawSagaId);
    return { saga, events: await this.sagas.listEvents(saga.id) };
  }
}

export class ListFleetSagas {
  private readonly sagas: SagaRepository;

  constructor(deps: { sagas: SagaRepository }) {
    this.sagas = deps.sagas;
  }

  execute(query: {
    fleetId: string;
    status?: SagaStatus | undefined;
    limit: number;
  }): Promise<readonly SagaTransaction[]> {
    return this.sagas.listByFleet(FleetId.parse(query.fleetId), {
      status: query.status,
      limit: query.limit,
    });
  }
}
