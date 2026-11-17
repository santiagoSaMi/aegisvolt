/** Vocabulario de la SAGA "Reservar y Activar Carga" (02-saga.md, ADR-0024). */

/**
 * Estados por hito ALCANZADO (no por paso en curso): el paso en curso se ve en
 * `steps` (IN_PROGRESS), que se persiste antes de llamar al servicio.
 */
export const SAGA_STATUSES = [
  'STARTED',
  'RESERVATION_COMPLETED',
  'BILLING_COMPLETED',
  'DISPATCH_COMPLETED',
  'COMPLETED',
  'COMPENSATING',
  'COMPENSATED',
  'FAILED',
  'COMPENSATION_FAILED',
] as const;
export const TERMINAL_STATUSES = ['COMPLETED', 'COMPENSATED', 'FAILED'] as const;
/** Estados de avance antes del pivote (activación): todavía se puede abandonar y compensar. */
export const PRE_PIVOT_STATUSES = [
  'STARTED',
  'RESERVATION_COMPLETED',
  'BILLING_COMPLETED',
] as const;

export type SagaStatus = (typeof SAGA_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const FORWARD_STEPS = ['RESERVATION', 'DEBIT', 'ACTIVATION', 'CONFIRMATION'] as const;
/** Orden de compensación: inverso al avance (abort → refund → release). */
export const COMPENSATION_STEPS = ['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION'] as const;
export type ForwardStep = (typeof FORWARD_STEPS)[number];
export type CompensationStep = (typeof COMPENSATION_STEPS)[number];
export type SagaStep = ForwardStep | CompensationStep;

export const STEP_STATUSES = ['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Rechazos de negocio definitivos que reporta cada servicio (no se reintentan). */
export const BUSINESS_REJECTIONS = {
  RESERVATION: [
    'STATION_NOT_FOUND',
    'CONNECTOR_NOT_FOUND',
    'CONNECTOR_UNAVAILABLE',
    'FAST_CHARGE_BOOST_DISABLED',
    'ULTRA_FAST_REQUIRES_BOOST',
  ],
  DEBIT: ['WALLET_NOT_FOUND', 'INSUFFICIENT_FUNDS'],
  ACTIVATION: ['CHARGER_HARDWARE_FAULT', 'CONNECTOR_BUSY'],
  CONFIRMATION: ['RESERVATION_HOLD_EXPIRED', 'RESERVATION_NOT_HELD'],
} as const;
export type BusinessRejection =
  (typeof BUSINESS_REJECTIONS)[keyof typeof BUSINESS_REJECTIONS][number];

/** Respuesta no recuperable que no es un rechazo de negocio conocido (400, 409 de idempotencia…). */
export const GENERIC_REJECTION = 'STEP_REJECTED';
export type GenericRejection = typeof GENERIC_REJECTION;

/** Abandono técnico de un paso cuyo resultado es desconocido. */
export const ABANDON_REASONS = ['STEP_RETRIES_EXHAUSTED', 'RECOVERY_DEADLINE_EXCEEDED'] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

export type RejectionReason = BusinessRejection | GenericRejection;
export type FailureReason = RejectionReason | AbandonReason;

export const SAGA_EVENT_TYPES = [
  'SAGA_STARTED',
  'STEP_STARTED',
  'STEP_SUCCEEDED',
  'STEP_FAILED',
  'COMPENSATION_STARTED',
  'COMPENSATION_STEP_STARTED',
  'COMPENSATION_SUCCEEDED',
  'COMPENSATION_STEP_FAILED',
  'COMPENSATION_RETRY_REQUESTED',
  'SAGA_COMPLETED',
  'SAGA_COMPENSATED',
  'SAGA_FAILED',
  'SAGA_COMPENSATION_FAILED',
  'RECOVERED',
] as const;
export type SagaEventType = (typeof SAGA_EVENT_TYPES)[number];

export function isTerminalStatus(status: SagaStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly SagaStatus[]).includes(status);
}

export function isPrePivotStatus(status: SagaStatus): boolean {
  return (PRE_PIVOT_STATUSES as readonly SagaStatus[]).includes(status);
}

export function isRejectionOf(step: ForwardStep, reason: string): reason is RejectionReason {
  return (
    reason === GENERIC_REJECTION ||
    (BUSINESS_REJECTIONS[step] as readonly string[]).includes(reason)
  );
}
