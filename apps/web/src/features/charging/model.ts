import { z } from 'zod';

import type { TimelineItem } from '../../shared/ui/components.tsx';
import type { Tone } from '../../shared/ui/status.ts';

/** SAGA tal como la devuelve `sagaStatus` / `reserveAndActivateCharging`. */
export interface SagaStep {
  readonly step: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
}

export interface Saga {
  readonly sagaId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly fleetId: string;
  readonly stationId: string;
  readonly connectorId: string;
  readonly requestedEnergyKwh: number;
  readonly correlationId: string;
  readonly reservationId: string;
  readonly debitId: string;
  readonly sessionId: string;
  readonly failureReason: string | null;
  readonly compensationPlan: readonly string[];
  readonly compensationFailure: {
    step: string;
    errorCode: string;
    nextAttemptAt: string | null;
  } | null;
  readonly steps: readonly SagaStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChargingEstimate {
  readonly connectorPowerKw: number;
  readonly estimated: { amountMinor: number; currency: string };
  readonly available: { amountMinor: number; currency: string };
  readonly sufficient: boolean;
  readonly tariffMinorPerKwh: number;
  readonly surgeApplied: boolean;
  readonly surgeMultiplierBasisPoints: number;
}

const FLEET = /^fleet_[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validación del formulario (formato y rangos; las reglas de negocio —saldo,
 * disponibilidad, precio— las aplica el backend). Los administradores deben
 * indicar la flota; los operadores usan la de su token.
 */
export function chargingFormSchema(isAdmin: boolean) {
  return z.object({
    fleetId: isAdmin
      ? z.string().trim().regex(FLEET, 'Indique una flota válida (fleet_…)')
      : // La flota del operador la decide el backend a partir de su token: no se envía.
        z
          .string()
          .optional()
          .transform(() => undefined),
    stationId: z.string().min(1, 'Seleccione una estación'),
    connectorId: z.string().min(1, 'Seleccione un conector disponible'),
    energyKwh: z.coerce
      .number({ error: 'Indique la energía en kWh' })
      .gt(0, 'Debe ser mayor que 0')
      .max(500, 'Máximo 500 kWh')
      .refine(
        (v) =>
          Number.isInteger(Math.round(v * 1000)) &&
          Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6,
        {
          error: 'Resolución máxima de 1 Wh (3 decimales)',
        },
      ),
  });
}

export type ChargingFormValues = Record<
  'fleetId' | 'stationId' | 'connectorId' | 'energyKwh',
  string
>;
export type ChargingInput = z.output<ReturnType<typeof chargingFormSchema>>;

const FORWARD: readonly [string, string][] = [
  ['RESERVATION', 'Reserva del conector'],
  ['DEBIT', 'Cobro del monto estimado'],
  ['ACTIVATION', 'Activación del cargador'],
  ['CONFIRMATION', 'Confirmación de la reserva'],
];
const COMPENSATION: Record<string, string> = {
  ABORT_SESSION: 'Compensación: abortar la sesión',
  REFUND_DEBIT: 'Compensación: reembolsar el cobro',
  RELEASE_RESERVATION: 'Compensación: liberar el conector',
};

/** Pasos de la SAGA para la línea de tiempo (estado tal como lo reporta el orquestador). */
export function sagaTimeline(saga: Saga): TimelineItem[] {
  const byStep = new Map(saga.steps.map((s) => [s.step, s]));
  const items: TimelineItem[] = FORWARD.filter(
    ([step]) => byStep.has(step) || saga.status === 'STARTED' || !saga.terminal,
  ).map(([step, title]) => {
    const state = byStep.get(step);
    return {
      key: step,
      title,
      status: state?.status ?? 'PENDING',
      detail: state?.lastErrorCode ?? undefined,
    };
  });
  for (const step of saga.compensationPlan) {
    const state = byStep.get(step);
    items.push({
      key: step,
      title: COMPENSATION[step] ?? step,
      status: state?.status ?? 'PENDING',
      detail: state?.lastErrorCode ?? undefined,
    });
  }
  return items;
}

const REASONS: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Saldo insuficiente en la billetera',
  CHARGER_HARDWARE_FAULT: 'El cargador reportó una falla de hardware',
  CONNECTOR_UNAVAILABLE: 'El conector ya no está disponible',
  CONNECTOR_BUSY: 'El conector está ocupado',
  FAST_CHARGE_BOOST_DISABLED: 'La carga rápida reforzada no está habilitada',
  STEP_RETRIES_EXHAUSTED: 'Un servicio no respondió a tiempo',
  RECOVERY_DEADLINE_EXCEEDED: 'La operación superó el tiempo máximo',
};

export function failureText(reason: string | null): string {
  return reason === null ? 'Sin detalle' : (REASONS[reason] ?? reason);
}

/** Resumen del resultado para el usuario (el estado lo decide el backend). */
export function sagaOutcome(saga: Saga): { tone: Tone; title: string; description: string } {
  switch (saga.status) {
    case 'COMPLETED':
      return {
        tone: 'success',
        title: 'Carga iniciada',
        description:
          'El conector quedó reservado, se cobró el monto estimado y el cargador está entregando energía.',
      };
    case 'COMPENSATED':
      return {
        tone: 'warning',
        title: 'La operación no se completó y se compensó',
        description: `${failureText(saga.failureReason)}. Se revirtieron los pasos realizados (reembolso y liberación del conector, según corresponda).`,
      };
    case 'FAILED':
      return {
        tone: 'danger',
        title: 'La operación no se pudo iniciar',
        description: `${failureText(saga.failureReason)}. No se realizó ningún cobro.`,
      };
    case 'COMPENSATION_FAILED':
      return {
        tone: 'danger',
        title: 'Compensación pendiente',
        description:
          'Una compensación falló y se reintentará automáticamente. Contacte a soporte con el correlation_id si persiste.',
      };
    default:
      return {
        tone: 'info',
        title: 'Operación en curso',
        description: 'Procesando la reserva, el cobro y la activación…',
      };
  }
}
