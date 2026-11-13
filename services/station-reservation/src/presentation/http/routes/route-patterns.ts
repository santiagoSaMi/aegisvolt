import { stationReservationV1 as api } from '@aegisvolt/contracts';

/**
 * Patrones de ruta Express derivados del contrato. No se usan los constructores
 * `api.paths.*` porque codifican los parámetros (`:` → `%3A`).
 */
const base = api.API.basePath;

export const ROUTES = {
  stations: `${base}/stations`,
  station: `${base}/stations/:stationId`,
  availableConnectors: `${base}/connectors/available`,
  reservations: `${base}/reservations`,
  reservation: `${base}/reservations/:reservationId`,
  confirmReservation: `${base}/reservations/:reservationId/confirm`,
  releaseReservation: `${base}/reservations/:reservationId/release`,
} as const;
