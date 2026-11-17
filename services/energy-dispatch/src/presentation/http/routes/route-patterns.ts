import { energyDispatchV1 as api } from '@aegisvolt/contracts';

/**
 * Patrones de ruta Express derivados del contrato. No se usan los constructores
 * `api.paths.*` porque codifican los parámetros (`:` → `%3A`).
 */
const base = api.API.basePath;

export const ROUTES = {
  session: `${base}/sessions/:sessionId`,
  abortSession: `${base}/sessions/:sessionId/abort`,
  stopSession: `${base}/sessions/:sessionId/stop`,
  sessionTelemetry: `${base}/sessions/:sessionId/telemetry`,
  stationSessions: `${base}/stations/:stationId/sessions`,
  chargerStatus: `${base}/stations/:stationId/connectors/:connectorId/charger`,
} as const;
