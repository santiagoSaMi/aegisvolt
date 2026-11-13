import {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  ReservationId,
  SagaId,
  SagaTransaction,
  SessionId,
  StationId,
  type CompensationStep,
  type FailureReason,
  type ForwardStep,
  type OperationKeys,
  type SagaEvent,
  type SagaEventType,
  type SagaStatus,
  type SagaStep,
  type SagaSteps,
  type StepStatus,
} from '../../domain/index.ts';
import { ENTITY, keys } from './table.ts';

interface StepItem {
  status: StepStatus;
  attempts: number;
  lastErrorCode?: string;
  updatedAt: string;
}

/** Ítem de la SAGA: incluye los datos mínimos para reanudar o compensar sin otra fuente. */
export interface SagaItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.saga;
  sagaId: string;
  idempotencyKey: string;
  fleetId: string;
  stationId: string;
  connectorId: string;
  requestedEnergyKwh: number;
  fastChargeBoost: boolean;
  reservationId: string;
  debitId: string;
  sessionId: string;
  operationKeys: Record<string, string>;
  correlationId: string;
  status: SagaStatus;
  steps: Partial<Record<SagaStep, StepItem>>;
  connectorPowerKw?: number;
  failureReason?: FailureReason;
  failedStep?: ForwardStep;
  compensationPlan: CompensationStep[];
  compensationFailure?: {
    step: CompensationStep;
    errorCode: string;
    detail?: string;
    round: number;
    failedAt: string;
    nextAttemptAt?: string;
  };
  compensationRounds: number;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
}

export interface SagaEventItem {
  PK: string;
  SK: string;
  entity: typeof ENTITY.event;
  sagaId: string;
  correlationId: string;
  sequence: number;
  type: SagaEventType;
  step?: SagaStep;
  status: SagaStatus;
  attempt?: number;
  errorCode?: string;
  occurredAt: string;
}

export function toSagaItem(
  saga: SagaTransaction,
  version: number,
  lease: { owner: string; expiresAt: Date },
): SagaItem {
  const steps: Partial<Record<SagaStep, StepItem>> = {};
  for (const [step, state] of Object.entries(saga.steps) as [SagaStep, SagaSteps[SagaStep]][]) {
    if (state !== undefined) {
      steps[step] = {
        status: state.status,
        attempts: state.attempts,
        updatedAt: state.updatedAt.toISOString(),
        ...(state.lastErrorCode === undefined ? {} : { lastErrorCode: state.lastErrorCode }),
      };
    }
  }
  const failure = saga.compensationFailure;
  const createdAt = saga.createdAt.toISOString();
  const updatedAt = saga.updatedAt.toISOString();
  return {
    ...keys.saga(saga.id),
    entity: ENTITY.saga,
    sagaId: saga.id,
    idempotencyKey: saga.idempotencyKey,
    fleetId: saga.request.fleetId,
    stationId: saga.request.stationId,
    connectorId: saga.request.connectorId,
    requestedEnergyKwh: saga.request.requestedEnergyKwh,
    fastChargeBoost: saga.request.fastChargeBoost,
    reservationId: saga.resources.reservationId,
    debitId: saga.resources.debitId,
    sessionId: saga.resources.sessionId,
    operationKeys: { ...saga.operationKeys },
    correlationId: saga.correlationId,
    status: saga.status,
    steps,
    ...(saga.connectorPowerKw === undefined ? {} : { connectorPowerKw: saga.connectorPowerKw }),
    ...(saga.failureReason === undefined ? {} : { failureReason: saga.failureReason }),
    ...(saga.failedStep === undefined ? {} : { failedStep: saga.failedStep }),
    compensationPlan: [...saga.compensationPlan],
    ...(failure === undefined
      ? {}
      : {
          compensationFailure: {
            step: failure.step,
            errorCode: failure.errorCode,
            round: failure.round,
            failedAt: failure.failedAt.toISOString(),
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
            ...(failure.nextAttemptAt === undefined
              ? {}
              : { nextAttemptAt: failure.nextAttemptAt.toISOString() }),
          },
        }),
    compensationRounds: saga.compensationRounds,
    eventCount: saga.eventCount,
    createdAt,
    updatedAt,
    version,
    leaseOwner: lease.owner,
    leaseExpiresAt: lease.expiresAt.toISOString(),
    GSI1PK: keys.fleet(saga.request.fleetId),
    GSI1SK: `${createdAt}#${saga.id}`,
    GSI2PK: keys.status(saga.status),
    GSI2SK: `${updatedAt}#${saga.id}`,
  };
}

export function fromSagaItem(item: SagaItem): SagaTransaction {
  const steps: Partial<Record<SagaStep, SagaSteps[SagaStep]>> = {};
  for (const [step, state] of Object.entries(item.steps) as [SagaStep, StepItem][]) {
    steps[step] = {
      status: state.status,
      attempts: state.attempts,
      updatedAt: new Date(state.updatedAt),
      ...(state.lastErrorCode === undefined ? {} : { lastErrorCode: state.lastErrorCode }),
    };
  }
  const failure = item.compensationFailure;
  return SagaTransaction.restore({
    id: SagaId.parse(item.sagaId),
    idempotencyKey: item.idempotencyKey,
    request: {
      fleetId: FleetId.parse(item.fleetId),
      stationId: StationId.parse(item.stationId),
      connectorId: ConnectorId.parse(item.connectorId),
      requestedEnergyKwh: item.requestedEnergyKwh,
      fastChargeBoost: item.fastChargeBoost,
    },
    resources: {
      reservationId: ReservationId.parse(item.reservationId),
      debitId: DebitId.parse(item.debitId),
      sessionId: SessionId.parse(item.sessionId),
    },
    operationKeys: item.operationKeys as unknown as OperationKeys,
    correlationId: CorrelationId.parse(item.correlationId),
    status: item.status,
    steps: steps as SagaSteps,
    ...(item.connectorPowerKw === undefined ? {} : { connectorPowerKw: item.connectorPowerKw }),
    ...(item.failureReason === undefined ? {} : { failureReason: item.failureReason }),
    ...(item.failedStep === undefined ? {} : { failedStep: item.failedStep }),
    compensationPlan: item.compensationPlan,
    ...(failure === undefined
      ? {}
      : {
          compensationFailure: {
            step: failure.step,
            errorCode: failure.errorCode,
            round: failure.round,
            failedAt: new Date(failure.failedAt),
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
            ...(failure.nextAttemptAt === undefined
              ? {}
              : { nextAttemptAt: new Date(failure.nextAttemptAt) }),
          },
        }),
    compensationRounds: item.compensationRounds,
    eventCount: item.eventCount,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
  });
}

export function toEventItem(saga: SagaTransaction, event: SagaEvent): SagaEventItem {
  return {
    ...keys.event(saga.id, event.sequence),
    entity: ENTITY.event,
    sagaId: saga.id,
    correlationId: saga.correlationId,
    sequence: event.sequence,
    type: event.type,
    status: event.status,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.step === undefined ? {} : { step: event.step }),
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
  };
}

export function fromEventItem(item: SagaEventItem): SagaEvent {
  return {
    sequence: item.sequence,
    type: item.type,
    status: item.status,
    occurredAt: new Date(item.occurredAt),
    ...(item.step === undefined ? {} : { step: item.step }),
    ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
    ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }),
  };
}
