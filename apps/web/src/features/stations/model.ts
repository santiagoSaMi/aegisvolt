/** Modelos de la vista de estaciones (forma de las respuestas GraphQL). */
export interface Connector {
  readonly connectorId: string;
  readonly type: string;
  readonly maxPowerKw: number;
  readonly ultraFast: boolean;
  readonly status: string;
  readonly availableForReservation: boolean;
}

export interface Station {
  readonly stationId: string;
  readonly name: string;
  readonly city: string;
  readonly connectors: readonly Connector[];
}

export interface ActiveSession {
  readonly sessionId: string;
  readonly connectorId: string;
  readonly status: string;
  readonly requestedEnergyKwh: number;
  readonly energyDeliveredKwh: number | null;
  readonly startedAt: string;
  readonly telemetry: readonly { timestamp: string; powerKw: number; energyKwh: number }[];
}

export interface ConnectorSummary {
  readonly total: number;
  readonly available: number;
  readonly reserved: number;
  readonly occupied: number;
  readonly outOfService: number;
}

/** Cuenta conectores por estado (presentación de datos ya calculados por el backend). */
export function summarizeConnectors(stations: readonly Station[]): ConnectorSummary {
  const summary = { total: 0, available: 0, reserved: 0, occupied: 0, outOfService: 0 };
  for (const connector of stations.flatMap((s) => s.connectors)) {
    summary.total++;
    if (connector.status === 'AVAILABLE') summary.available++;
    else if (connector.status === 'RESERVED') summary.reserved++;
    else if (connector.status === 'OCCUPIED') summary.occupied++;
    else summary.outOfService++;
  }
  return summary;
}
