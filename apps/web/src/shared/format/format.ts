/** Formato de presentación (sin reglas de negocio: los importes ya vienen calculados). */

const MINOR_DIGITS: Record<string, number> = { COP: 2, USD: 2, EUR: 2 };

/** Importe en unidades menores → texto localizado (p. ej. 3 000 000 → "$ 30.000,00"). */
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = MINOR_DIGITS[currency] ?? 2;
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return '—';
  }
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(iso));
}

export function formatKwh(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(value)} kWh`;
}

/** Acorta un id largo para tablas (`saga_0f5e2a3c…`); el completo va en `title`. */
export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 15)}…` : id;
}
