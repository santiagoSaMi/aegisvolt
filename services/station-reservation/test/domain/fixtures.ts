import {
  ChargingConnector,
  ConnectorId,
  FleetId,
  PowerKw,
  ReservationId,
  SagaId,
  StationId,
  type ReservationTerms,
} from '../../src/domain/index.ts';

export const NOW = new Date('2026-11-13T15:00:00.000Z');
export const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

export const STATION_ID = StationId.parse('st_bog-norte-01');
export const CONNECTOR_ID = ConnectorId.parse('cn_01');
export const RESERVATION_ID = ReservationId.parse('res_3f2c1e5a-1b2c-4d3e-8f90-123456789abc');
export const OTHER_RESERVATION_ID = ReservationId.parse('res_00000000-0000-4000-8000-000000000001');

export function connector(maxPowerKw = 60): ChargingConnector {
  return ChargingConnector.create({
    id: CONNECTOR_ID,
    stationId: STATION_ID,
    type: 'CCS2',
    maxPower: PowerKw.of(maxPowerKw),
  });
}

export function terms(overrides: Partial<ReservationTerms> = {}): ReservationTerms {
  return {
    sagaId: SagaId.parse('saga_3f2c1e5a-1b2c-4d3e-8f90-123456789abc'),
    fleetId: FleetId.parse('fleet_001'),
    stationId: STATION_ID,
    connectorId: CONNECTOR_ID,
    fastChargeBoost: false,
    ...overrides,
  };
}
