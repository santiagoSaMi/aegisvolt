import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  ConfirmReservation,
  CreateReservation,
  GetAvailableConnectors,
  GetReservation,
  ListFleetReservations,
  GetStation,
  ListStations,
  RegisterStation,
  ReleaseReservation,
  type Clock,
  type FeatureFlagReader,
} from './application/index.ts';
import { ReservationPolicy, type ReservationPolicyConfig } from './domain/index.ts';
import { DynamoDbReservationRepository } from './infrastructure/dynamodb/dynamodb-reservation-repository.ts';
import { DynamoDbStationRepository } from './infrastructure/dynamodb/dynamodb-station-repository.ts';

/**
 * Cableado de casos de uso con los repositorios DynamoDB. Lo usan `main.ts` y
 * las pruebas de integración (con reloj y flags controlados).
 */
export function createUseCases(deps: {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  clock: Clock;
  flags: FeatureFlagReader;
  reservationPolicy: ReservationPolicyConfig;
}) {
  const stations = new DynamoDbStationRepository(deps.documentClient, deps.tableName);
  const reservations = new DynamoDbReservationRepository(deps.documentClient, deps.tableName);
  const policy = new ReservationPolicy(deps.reservationPolicy);
  const { clock, flags } = deps;

  return {
    registerStation: new RegisterStation({ stations }),
    getStation: new GetStation({ stations, clock }),
    listStations: new ListStations({ stations, clock }),
    getAvailableConnectors: new GetAvailableConnectors({ stations, clock }),
    createReservation: new CreateReservation({ reservations, flags, policy, clock }),
    confirmReservation: new ConfirmReservation({ reservations, clock }),
    releaseReservation: new ReleaseReservation({ reservations, clock }),
    getReservation: new GetReservation({ reservations, clock }),
    listFleetReservations: new ListFleetReservations({ reservations, clock }),
  };
}
