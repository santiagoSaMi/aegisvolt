/** Tono visual de un estado. Siempre acompañado de texto (nunca solo color). */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface StatusInfo {
  readonly label: string;
  readonly tone: Tone;
}

/** Etiquetas en español y tono de los estados que devuelve el backend. */
const STATUS: Record<string, StatusInfo> = {
  // Conectores
  AVAILABLE: { label: 'Disponible', tone: 'success' },
  RESERVED: { label: 'Reservado', tone: 'warning' },
  OCCUPIED: { label: 'Ocupado', tone: 'info' },
  OUT_OF_SERVICE: { label: 'Fuera de servicio', tone: 'neutral' },
  // Reservas
  HELD: { label: 'Retenida', tone: 'warning' },
  CONFIRMED: { label: 'Confirmada', tone: 'info' },
  RELEASED: { label: 'Liberada', tone: 'neutral' },
  EXPIRED: { label: 'Vencida', tone: 'neutral' },
  VOIDED: { label: 'Anulada', tone: 'neutral' },
  // Sesiones
  ACTIVE: { label: 'Cargando', tone: 'info' },
  ABORTED: { label: 'Abortada', tone: 'warning' },
  // SAGA
  STARTED: { label: 'Iniciada', tone: 'info' },
  RESERVATION_COMPLETED: { label: 'Reserva hecha', tone: 'info' },
  BILLING_COMPLETED: { label: 'Cobro hecho', tone: 'info' },
  DISPATCH_COMPLETED: { label: 'Carga activada', tone: 'info' },
  COMPLETED: { label: 'Completada', tone: 'success' },
  COMPENSATING: { label: 'Compensando', tone: 'warning' },
  COMPENSATED: { label: 'Compensada', tone: 'warning' },
  FAILED: { label: 'Fallida', tone: 'danger' },
  COMPENSATION_FAILED: { label: 'Compensación fallida', tone: 'danger' },
  // Movimientos
  DEBIT: { label: 'Débito', tone: 'neutral' },
  REFUND: { label: 'Reembolso', tone: 'success' },
  TOP_UP: { label: 'Recarga', tone: 'info' },
  // Pasos
  SUCCEEDED: { label: 'Hecho', tone: 'success' },
  IN_PROGRESS: { label: 'En curso', tone: 'info' },
  PENDING: { label: 'Pendiente', tone: 'neutral' },
};

export function statusInfo(status: string): StatusInfo {
  return STATUS[status] ?? { label: status, tone: 'neutral' };
}
