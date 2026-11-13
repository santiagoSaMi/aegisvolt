import {
  ConfirmReservation,
  CreateReservation,
  GetAvailableConnectors,
  GetReservation,
  GetStation,
  ListStations,
  RegisterStation,
  ReleaseReservation,
  type RegisterStationCommand,
} from '../../src/application/index.ts';
import { ReservationPolicy } from '../../src/domain/index.ts';
import { StaticFeatureFlagReader } from '../../src/infrastructure/feature-flags/static-feature-flag-reader.ts';
import { FixedClock, InMemoryStore } from './in-memory-store.ts';

export const START = new Date('2026-11-13T15:00:00.000Z');
export const STATION_ID = 'st_bog-norte-01';
export const CONNECTOR_ID = 'cn_01';
export const ULTRA_CONNECTOR_ID = 'cn_02';
export const SAGA_A = 'saga_00000000-0000-4000-8000-00000000000a';
export const SAGA_B = 'saga_00000000-0000-4000-8000-00000000000b';
export const RES_A = 'res_00000000-0000-4000-8000-00000000000a';
export const RES_B = 'res_00000000-0000-4000-8000-00000000000b';

export const STATION: RegisterStationCommand = {
  stationId: STATION_ID,
  name: 'Electrolinera Norte',
  city: 'bogota',
  location: { latitude: 4.75, longitude: -74.05 },
  connectors: [
    { connectorId: CONNECTOR_ID, type: 'CCS2', maxPowerKw: 60 },
    { connectorId: ULTRA_CONNECTOR_ID, type: 'CCS2', maxPowerKw: 180 },
  ],
};

export function reservationCommand(
  overrides: Partial<Parameters<CreateReservation['execute']>[0]> = {},
) {
  return {
    reservationId: RES_A,
    sagaId: SAGA_A,
    fleetId: 'fleet_001',
    stationId: STATION_ID,
    connectorId: CONNECTOR_ID,
    fastChargeBoost: false,
    ...overrides,
  };
}

/** Casos de uso reales sobre el almacén en memoria, con reloj y flags controlados. */
export function createTestContext(options: { fastChargeBoost?: boolean } = {}) {
  const store = new InMemoryStore();
  const clock = new FixedClock(START);
  const stations = store.stationRepository;
  const reservations = store.reservationRepository;
  const flags = new StaticFeatureFlagReader({
    ENABLE_FAST_CHARGE_BOOST: options.fastChargeBoost ?? false,
  });
  const policy = new ReservationPolicy();
  const useCases = {
    registerStation: new RegisterStation({ stations }),
    getStation: new GetStation({ stations, clock }),
    listStations: new ListStations({ stations, clock }),
    getAvailableConnectors: new GetAvailableConnectors({ stations, clock }),
    createReservation: new CreateReservation({ reservations, flags, policy, clock }),
    confirmReservation: new ConfirmReservation({ reservations, clock }),
    releaseReservation: new ReleaseReservation({ reservations, clock }),
    getReservation: new GetReservation({ reservations, clock }),
  };
  return { store, clock, useCases };
}
