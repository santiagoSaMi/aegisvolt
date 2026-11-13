import type { sagaOrchestratorV1 } from '@aegisvolt/contracts';
import type { z } from 'zod';

import type { SagaEvent, SagaStep, SagaTransaction } from '../../domain/index.ts';

type SagaView = z.input<typeof sagaOrchestratorV1.sagaViewSchema>;
type SagaEventView = z.input<typeof sagaOrchestratorV1.sagaEventViewSchema>;

export function toSagaView(saga: SagaTransaction): SagaView {
  const failure = saga.compensationFailure;
  return {
    sagaId: saga.id,
    status: saga.status,
    terminal: saga.isTerminal,
    fleetId: saga.request.fleetId,
    stationId: saga.request.stationId,
    connectorId: saga.request.connectorId,
    requestedEnergyKwh: saga.request.requestedEnergyKwh,
    fastChargeBoost: saga.request.fastChargeBoost,
    correlationId: saga.correlationId,
    reservationId: saga.resources.reservationId,
    debitId: saga.resources.debitId,
    sessionId: saga.resources.sessionId,
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
    steps: (
      Object.entries(saga.steps) as [SagaStep, NonNullable<SagaTransaction['steps'][SagaStep]>][]
    ).map(([step, state]) => ({
      step,
      status: state.status,
      attempts: state.attempts,
      idempotencyKey: saga.idempotencyKeyFor(step),
      updatedAt: state.updatedAt.toISOString(),
      ...(state.lastErrorCode === undefined
        ? {}
        : { lastErrorCode: errorCode(state.lastErrorCode) }),
    })),
    createdAt: saga.createdAt.toISOString(),
    updatedAt: saga.updatedAt.toISOString(),
  };
}

export function toEventView(saga: SagaTransaction, event: SagaEvent): SagaEventView {
  return {
    sequence: event.sequence,
    type: event.type,
    status: event.status,
    occurredAt: event.occurredAt.toISOString(),
    correlationId: saga.correlationId,
    ...(event.step === undefined ? {} : { step: event.step }),
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(event.errorCode === undefined ? {} : { errorCode: errorCode(event.errorCode) }),
  };
}

/** Los códigos de error del contrato son MAYÚSCULAS_CON_GUIONES_BAJOS. */
function errorCode(code: string): string {
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'UNKNOWN_ERROR';
}
