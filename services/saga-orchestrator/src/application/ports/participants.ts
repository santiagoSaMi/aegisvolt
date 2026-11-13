import type {
  ConnectorId,
  CorrelationId,
  DebitId,
  FleetId,
  ReservationId,
  SagaId,
  SessionId,
  StationId,
} from '../../domain/index.ts';

/**
 * Resultado de una llamada a un servicio participante, ya clasificado:
 * - OK: el servicio confirmó la operación (respuesta validada con su contrato);
 * - REJECTED: respuesta definitiva que NO se reintenta (4xx de negocio o de validación);
 * - TRANSIENT: el resultado es desconocido o el servicio no pudo atenderla
 *   (red, timeout, 5xx, 429): se puede reintentar con la misma clave idempotente.
 */
export type CallOutcome<T> =
  | { readonly kind: 'OK'; readonly value: T }
  | { readonly kind: 'REJECTED'; readonly code: string; readonly detail?: string }
  | { readonly kind: 'TRANSIENT'; readonly code: string; readonly detail?: string };

/**
 * Trazabilidad que viaja en CADA llamada: `x-correlation-id` (el original de la
 * SAGA, también en la recuperación), `x-saga-id` e `idempotency-key` del paso.
 */
export interface CallContext {
  readonly sagaId: SagaId;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
}

/** Motivo de compensación del contrato común (`COMPENSATION_REASONS`). */
export type CompensationReason =
  | 'INSUFFICIENT_FUNDS'
  | 'CHARGER_HARDWARE_FAULT'
  | 'FORWARD_STEP_FAILED'
  | 'RECOVERY_DEADLINE_EXCEEDED'
  | 'OPERATOR_REQUEST';

export interface StationReservationPort {
  /** Potencia del conector (necesaria para el precio del débito). */
  getConnectorPower(
    target: { stationId: StationId; connectorId: ConnectorId },
    ctx: CallContext,
  ): Promise<CallOutcome<{ maxPowerKw: number }>>;
  holdReservation(
    command: {
      reservationId: ReservationId;
      sagaId: SagaId;
      fleetId: FleetId;
      stationId: StationId;
      connectorId: ConnectorId;
      fastChargeBoost: boolean;
    },
    ctx: CallContext,
  ): Promise<CallOutcome<{ status: string }>>;
  confirmReservation(
    reservationId: ReservationId,
    ctx: CallContext,
  ): Promise<CallOutcome<{ status: string }>>;
  releaseReservation(
    reservationId: ReservationId,
    reason: CompensationReason,
    ctx: CallContext,
  ): Promise<CallOutcome<{ status: string; outcome: string }>>;
}

export interface BillingWalletPort {
  debit(
    command: {
      debitId: DebitId;
      sagaId: SagaId;
      fleetId: FleetId;
      energyKwh: number;
      connectorPowerKw: number;
    },
    ctx: CallContext,
  ): Promise<CallOutcome<{ status: string; amountMinor: number }>>;
  refundDebit(
    debitId: DebitId,
    reason: CompensationReason,
    ctx: CallContext,
  ): Promise<CallOutcome<{ status: string; outcome: string }>>;
}

export interface EnergyDispatchPort {
  activateSession(
    command: {
      sessionId: SessionId;
      sagaId: SagaId;
      stationId: StationId;
      connectorId: ConnectorId;
      energyKwh: number;
    },
    ctx: CallContext,
  ): Promise<CallOutcome<{ status: string }>>;
  /** Estado real de la sesión (para resolver un resultado desconocido en el pivote). */
  getSession(sessionId: SessionId, ctx: CallContext): Promise<CallOutcome<{ status: string }>>;
  abortSession(
    sessionId: SessionId,
    reason: CompensationReason,
    ctx: CallContext,
  ): Promise<CallOutcome<{ status: string; outcome: string }>>;
}

export interface SagaParticipants {
  readonly station: StationReservationPort;
  readonly billing: BillingWalletPort;
  readonly dispatch: EnergyDispatchPort;
}
