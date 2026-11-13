/** Vocabulario de la SAGA "Reservar y Activar Carga" (02-saga.md). */

export const FORWARD_STATUSES = [
  'STARTED',
  'RESERVING',
  'DEBITING',
  'ACTIVATING',
  'CONFIRMING',
] as const;
export const COMPENSATION_STATUSES = ['COMPENSATING', 'COMPENSATION_PENDING'] as const;
export const TERMINAL_STATUSES = [
  'COMPLETED',
  'COMPENSATED',
  'FAILED',
  'REQUIRES_ATTENTION',
] as const;
export const SAGA_STATUSES = [
  ...FORWARD_STATUSES,
  ...COMPENSATION_STATUSES,
  ...TERMINAL_STATUSES,
] as const;

export type ForwardStatus = (typeof FORWARD_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type SagaStatus = (typeof SAGA_STATUSES)[number];

export const FORWARD_STEPS = ['RESERVATION', 'DEBIT', 'ACTIVATION', 'CONFIRMATION'] as const;
/** Orden de compensación: inverso al avance (abort → refund → release). */
export const COMPENSATION_STEPS = ['ABORT_SESSION', 'REFUND_DEBIT', 'RELEASE_RESERVATION'] as const;
export type ForwardStep = (typeof FORWARD_STEPS)[number];
export type CompensationStep = (typeof COMPENSATION_STEPS)[number];
export type SagaStep = ForwardStep | CompensationStep;

export const STEP_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Rechazos de negocio definitivos que reporta un servicio (no se reintentan). */
export const BUSINESS_REJECTIONS = {
  RESERVATION: ['CONNECTOR_UNAVAILABLE', 'FAST_CHARGE_BOOST_DISABLED', 'ULTRA_FAST_REQUIRES_BOOST'],
  DEBIT: ['INSUFFICIENT_FUNDS'],
  ACTIVATION: ['CHARGER_HARDWARE_FAULT'],
} as const;
export type BusinessRejection =
  (typeof BUSINESS_REJECTIONS)[keyof typeof BUSINESS_REJECTIONS][number];

/** Abandono técnico de un paso cuyo resultado es desconocido. */
export const ABANDON_REASONS = ['STEP_RETRIES_EXHAUSTED', 'RECOVERY_DEADLINE_EXCEEDED'] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

export type FailureReason = BusinessRejection | AbandonReason;

export const SAGA_EVENT_TYPES = [
  'SAGA_STARTED',
  'STEP_STARTED',
  'STEP_SUCCEEDED',
  'STEP_FAILED',
  'COMPENSATION_STARTED',
  'COMPENSATION_SUCCEEDED',
  'COMPENSATION_FAILED',
  'SAGA_COMPLETED',
  'SAGA_COMPENSATED',
  'SAGA_FAILED',
  'SAGA_REQUIRES_ATTENTION',
  'RECOVERED',
] as const;
export type SagaEventType = (typeof SAGA_EVENT_TYPES)[number];

export function isTerminalStatus(status: SagaStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly SagaStatus[]).includes(status);
}

export function isForwardStatus(status: SagaStatus): status is ForwardStatus {
  return (FORWARD_STATUSES as readonly SagaStatus[]).includes(status);
}
