import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  AbortChargingSession,
  GetChargerStatus,
  GetChargingSession,
  ListSessionTelemetry,
  ListStationSessions,
  RecordTelemetry,
  StartChargingSession,
  StopChargingSession,
  type ChargerAdapter,
  type Clock,
} from './application/index.ts';
import { DynamoDbSessionRepository } from './infrastructure/dynamodb/dynamodb-session-repository.ts';

/**
 * Cableado de casos de uso con el repositorio DynamoDB. El cargador llega como
 * puerto: `main.ts` inyecta el simulado; las pruebas, dobles controlados.
 */
export function createUseCases(deps: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  telemetryRetentionDays: number;
  charger: ChargerAdapter;
  clock: Clock;
}) {
  const sessions = new DynamoDbSessionRepository(
    deps.documentClient,
    deps.tableName,
    deps.telemetryRetentionDays,
  );
  const { charger, clock } = deps;

  return {
    startChargingSession: new StartChargingSession({ sessions, charger, clock }),
    stopChargingSession: new StopChargingSession({ sessions, charger, clock }),
    abortChargingSession: new AbortChargingSession({ sessions, charger, clock }),
    recordTelemetry: new RecordTelemetry({ sessions }),
    getChargingSession: new GetChargingSession({ sessions }),
    listSessionTelemetry: new ListSessionTelemetry({ sessions }),
    listStationSessions: new ListStationSessions({ sessions }),
    getChargerStatus: new GetChargerStatus({ sessions, charger, clock }),
  };
}
