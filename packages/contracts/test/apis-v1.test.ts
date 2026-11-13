import { describe, expect, it } from 'vitest';

import {
  billingWalletV1,
  energyDispatchV1,
  featureFlagsV1,
  sagaOrchestratorV1,
  stationReservationV1,
} from '../src/index.ts';

const UUID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const NOW = '2026-11-13T15:04:05.000Z';
const ids = {
  sagaId: `saga_${UUID}`,
  fleetId: 'fleet_001',
  stationId: 'st_bog-norte-01',
  connectorId: 'cn_01',
  reservationId: `res_${UUID}`,
  debitId: `dbt_${UUID}`,
  sessionId: `ses_${UUID}`,
};

describe('station-reservation v1', () => {
  const api = stationReservationV1;

  it('expone versión y rutas', () => {
    expect(api.API).toEqual({ name: 'station-reservation', version: '1.0.0', basePath: '/v1' });
    expect(api.paths.releaseReservation(ids.reservationId)).toBe(
      `/v1/reservations/${ids.reservationId}/release`,
    );
  });

  it('valida el comando de hold y rechaza campos desconocidos (p. ej. holdSeconds)', () => {
    const request = {
      sagaId: ids.sagaId,
      fleetId: ids.fleetId,
      stationId: ids.stationId,
      connectorId: ids.connectorId,
      fastChargeBoost: false,
    };
    expect(api.holdReservationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      api.holdReservationRequestSchema.safeParse({ ...request, holdSeconds: 9999 }).success,
    ).toBe(false);
    expect(
      api.holdReservationRequestSchema.safeParse({ ...request, fleetId: 'fleet-001' }).success,
    ).toBe(false);
  });

  it('tolera campos nuevos en las respuestas (tolerant reader)', () => {
    const view = {
      reservationId: ids.reservationId,
      sagaId: ids.sagaId,
      fleetId: ids.fleetId,
      stationId: ids.stationId,
      connectorId: ids.connectorId,
      status: 'HELD',
      fastChargeBoost: false,
      holdExpiresAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      campoFuturo: 'se ignora',
    };
    expect(api.reservationViewSchema.parse(view)).not.toHaveProperty('campoFuturo');
  });

  it('release exige un motivo de compensación conocido', () => {
    expect(
      api.releaseReservationRequestSchema.safeParse({ reason: 'INSUFFICIENT_FUNDS' }).success,
    ).toBe(true);
    expect(api.releaseReservationRequestSchema.safeParse({ reason: 'PORQUE_SI' }).success).toBe(
      false,
    );
  });

  it('los errores de negocio usan el status HTTP del catálogo', () => {
    expect(api.ERROR_CODES.CONNECTOR_UNAVAILABLE).toBe(409);
    expect(api.ERROR_CODES.FAST_CHARGE_BOOST_DISABLED).toBe(403);
    expect(
      api.problemSchema.safeParse({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'CONNECTOR_UNAVAILABLE',
      }).success,
    ).toBe(true);
    expect(
      api.problemSchema.safeParse({
        type: 'about:blank',
        title: 'X',
        status: 422,
        code: 'INSUFFICIENT_FUNDS',
      }).success,
    ).toBe(false);
  });
});

describe('billing-wallet v1', () => {
  const api = billingWalletV1;

  it('el débito no acepta importes del cliente: el servicio calcula el precio', () => {
    const request = {
      sagaId: ids.sagaId,
      fleetId: ids.fleetId,
      energyKwh: 32.5,
      connectorPowerKw: 150,
    };
    expect(api.debitRequestSchema.safeParse(request).success).toBe(true);
    expect(
      api.debitRequestSchema.safeParse({ ...request, amount: { amountMinor: 1, currency: 'COP' } })
        .success,
    ).toBe(false);
  });

  it('el multiplicador de surge nunca es menor que 1×', () => {
    const view = {
      debitId: ids.debitId,
      sagaId: ids.sagaId,
      fleetId: ids.fleetId,
      status: 'DEBITED',
      amount: { amountMinor: 3_250_000, currency: 'COP' },
      pricing: {
        tariffMinorPerKwh: 100_000,
        surgeMultiplierBasisPoints: 10_000,
        surgeApplied: false,
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(api.debitViewSchema.safeParse(view).success).toBe(true);
    expect(
      api.debitViewSchema.safeParse({
        ...view,
        pricing: { ...view.pricing, surgeMultiplierBasisPoints: 9_000 },
      }).success,
    ).toBe(false);
  });

  it('la recarga exige un importe positivo', () => {
    expect(
      api.topUpRequestSchema.safeParse({ amount: { amountMinor: 0, currency: 'COP' } }).success,
    ).toBe(false);
    expect(
      api.topUpRequestSchema.safeParse({ amount: { amountMinor: 100, currency: 'COP' } }).success,
    ).toBe(true);
  });

  it('INSUFFICIENT_FUNDS es 422 (definitivo, no se reintenta)', () => {
    expect(api.ERROR_CODES.INSUFFICIENT_FUNDS).toBe(422);
  });
});

describe('energy-dispatch v1', () => {
  const api = energyDispatchV1;

  it('el problema de falla de hardware incluye código y si fue simulada', () => {
    const problem = {
      type: 'about:blank',
      title: 'Charger hardware fault',
      status: 422,
      code: 'CHARGER_HARDWARE_FAULT',
      faultCode: 'E-HW-001',
      simulated: true,
    };
    expect(api.chargerFaultProblemSchema.safeParse(problem).success).toBe(true);
    expect(api.chargerFaultProblemSchema.safeParse({ ...problem, faultCode: 'HW1' }).success).toBe(
      false,
    );
  });

  it('telemetría: rangos físicos plausibles', () => {
    const record = {
      sessionId: ids.sessionId,
      recordedAt: NOW,
      powerKw: 148.2,
      energyDeliveredKwh: 12.4,
      voltageV: 780,
      temperatureC: 41.5,
    };
    expect(api.telemetryRecordViewSchema.safeParse(record).success).toBe(true);
    expect(api.telemetryRecordViewSchema.safeParse({ ...record, temperatureC: 300 }).success).toBe(
      false,
    );
    expect(api.listTelemetryQuerySchema.parse({})).toEqual({ limit: 50 });
  });
});

describe('saga-orchestrator v1', () => {
  const api = sagaOrchestratorV1;

  it('fastChargeBoost es false por defecto', () => {
    expect(
      api.startSagaRequestSchema.parse({
        fleetId: ids.fleetId,
        stationId: ids.stationId,
        connectorId: ids.connectorId,
        requestedEnergyKwh: 40,
      }).fastChargeBoost,
    ).toBe(false);
  });

  it('los estados terminales son un subconjunto de los estados', () => {
    for (const status of api.TERMINAL_SAGA_STATUSES) {
      expect(api.SAGA_STATUSES).toContain(status);
    }
  });

  it('la lista de SAGAs exige fleetId', () => {
    expect(api.listSagasQuerySchema.safeParse({}).success).toBe(false);
    expect(api.listSagasQuerySchema.parse({ fleetId: ids.fleetId })).toEqual({
      fleetId: ids.fleetId,
      limit: 20,
    });
  });
});

describe('feature-flags v1', () => {
  it('declara las tres flags de la especificación y quién las evalúa', () => {
    expect(featureFlagsV1.FEATURE_FLAG_KEYS).toEqual([
      'ENABLE_DYNAMIC_SURGE_PRICING',
      'ENABLE_FAST_CHARGE_BOOST',
      'SIMULATE_CHARGER_HARDWARE_FAULT',
    ]);
    expect(Object.keys(featureFlagsV1.FEATURE_FLAG_EVALUATORS).sort()).toEqual(
      [...featureFlagsV1.FEATURE_FLAG_KEYS].sort(),
    );
  });

  it('valida el estado leído del almacén de flags', () => {
    expect(
      featureFlagsV1.featureFlagStateSchema.safeParse({
        key: 'ENABLE_FAST_CHARGE_BOOST',
        enabled: true,
        version: 3,
        updatedAt: NOW,
        updatedBy: 'admin@aegisvolt',
      }).success,
    ).toBe(true);
    expect(
      featureFlagsV1.featureFlagStateSchema.safeParse({
        key: 'UNKNOWN_FLAG',
        enabled: true,
        version: 1,
        updatedAt: NOW,
        updatedBy: 'x',
      }).success,
    ).toBe(false);
  });
});
