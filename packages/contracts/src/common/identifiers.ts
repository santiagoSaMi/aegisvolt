import { z } from 'zod';

/**
 * Identificadores explícitos y estables: `<prefijo>_<valor>`.
 *
 * - El prefijo indica el tipo de recurso y nunca cambia (forma parte del contrato).
 * - El valor es minúsculas, dígitos y guiones (1–63 caracteres).
 *   - Recursos de catálogo (estaciones, conectores, flotas): legibles, p. ej. `st_bog-norte-01`.
 *   - Recursos generados (sagas, reservas, débitos, sesiones…): UUID v4, p. ej.
 *     `saga_3f2c1e5a-1b2c-4d3e-8f90-123456789abc`.
 */
export const ID_PREFIXES = {
  station: 'st',
  connector: 'cn',
  fleet: 'fleet',
  saga: 'saga',
  reservation: 'res',
  debit: 'dbt',
  topUp: 'tup',
  walletTransaction: 'wtx',
  session: 'ses',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const ID_VALUE_PATTERN = '[a-z0-9][a-z0-9-]{0,62}';

export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_${ID_VALUE_PATTERN}$`);
}

function prefixedId<const TBrand extends string>(prefix: IdPrefix, brand: TBrand) {
  return z
    .string()
    .regex(idPattern(prefix), { error: `Debe tener el formato ${prefix}_<valor>` })
    .brand(brand);
}

export const stationIdSchema = prefixedId(ID_PREFIXES.station, 'StationId');
export const connectorIdSchema = prefixedId(ID_PREFIXES.connector, 'ConnectorId');
export const fleetIdSchema = prefixedId(ID_PREFIXES.fleet, 'FleetId');
export const sagaIdSchema = prefixedId(ID_PREFIXES.saga, 'SagaId');
export const reservationIdSchema = prefixedId(ID_PREFIXES.reservation, 'ReservationId');
export const debitIdSchema = prefixedId(ID_PREFIXES.debit, 'DebitId');
export const topUpIdSchema = prefixedId(ID_PREFIXES.topUp, 'TopUpId');
export const walletTransactionIdSchema = prefixedId(
  ID_PREFIXES.walletTransaction,
  'WalletTransactionId',
);
export const sessionIdSchema = prefixedId(ID_PREFIXES.session, 'SessionId');

export type StationId = z.output<typeof stationIdSchema>;
export type ConnectorId = z.output<typeof connectorIdSchema>;
export type FleetId = z.output<typeof fleetIdSchema>;
export type SagaId = z.output<typeof sagaIdSchema>;
export type ReservationId = z.output<typeof reservationIdSchema>;
export type DebitId = z.output<typeof debitIdSchema>;
export type TopUpId = z.output<typeof topUpIdSchema>;
export type WalletTransactionId = z.output<typeof walletTransactionIdSchema>;
export type SessionId = z.output<typeof sessionIdSchema>;

/** `correlation_id` de una petición (ADR-0009): UUID. */
export const correlationIdSchema = z.uuid();
/** Clave de idempotencia de una acción del usuario (ADR-0005): UUID generado por el cliente. */
export const idempotencyKeySchema = z.uuid();
