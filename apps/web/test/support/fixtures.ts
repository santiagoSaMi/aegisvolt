import type { RuntimeConfig } from '../../src/config/runtime-config.ts';
import type { Viewer } from '../../src/shared/api/viewer.ts';
import type { Saga } from '../../src/features/charging/model.ts';

export const testConfig: RuntimeConfig = {
  environment: 'dev',
  graphqlUrl: './graphql',
  auth: { cognitoUrl: './auth/cognito', clientId: 'client-test' },
  pollingIntervalMs: 1000,
  cities: ['bogota'],
};

export const operator: Viewer = {
  subject: 'sub-op',
  groups: ['fleet-operators'],
  fleetId: 'fleet_alfa',
  isAdmin: false,
  environment: 'dev',
};

export const admin: Viewer = {
  subject: 'sub-admin',
  groups: ['platform-admins'],
  fleetId: null,
  isAdmin: true,
  environment: 'dev',
};

const money = (amountMinor: number) => ({ __typename: 'Money', amountMinor, currency: 'COP' });

export function connector(connectorId: string, status: string) {
  return {
    __typename: 'Connector',
    connectorId,
    type: 'CCS2',
    maxPowerKw: 150,
    ultraFast: false,
    status,
    availableForReservation: status === 'AVAILABLE',
  };
}

export const station = {
  __typename: 'Station',
  stationId: 'st_norte',
  name: 'Estación Norte',
  city: 'bogota',
  connectors: [
    connector('c1', 'AVAILABLE'),
    connector('c2', 'OCCUPIED'),
    connector('c3', 'RESERVED'),
  ],
};

export const estimate = {
  __typename: 'ChargingEstimate',
  connectorPowerKw: 150,
  estimated: money(30_000_00),
  available: money(500_000_00),
  sufficient: true,
  tariffMinorPerKwh: 1_000_00,
  surgeApplied: false,
  surgeMultiplierBasisPoints: 10_000,
};

export { money };

export function saga(overrides: Partial<Saga> & { status: string }): Saga & { __typename: string } {
  const terminal = ['COMPLETED', 'COMPENSATED', 'FAILED', 'COMPENSATION_FAILED'].includes(
    overrides.status,
  );
  const base = {
    __typename: 'Saga',
    sagaId: 'saga_0001',
    terminal,
    fleetId: 'fleet_alfa',
    stationId: 'st_norte',
    connectorId: 'c1',
    requestedEnergyKwh: 30,
    correlationId: 'corr-1234-5678',
    reservationId: 'res_1',
    debitId: 'deb_1',
    sessionId: 'ses_1',
    failureReason: null,
    compensationPlan: [] as string[],
    compensationFailure: null,
    steps: [] as Saga['steps'],
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:01.000Z',
  };
  return { ...base, ...overrides, terminal: overrides.terminal ?? terminal };
}

export function step(name: string, status: string, lastErrorCode: string | null = null) {
  return { __typename: 'SagaStep', step: name, status, attempts: 1, lastErrorCode };
}
