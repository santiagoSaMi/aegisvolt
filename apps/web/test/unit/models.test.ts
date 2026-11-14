import { CombinedGraphQLErrors, ServerError } from '@apollo/client/errors';
import { describe, expect, it } from 'vitest';

import {
  chargingFormSchema,
  sagaOutcome,
  sagaTimeline,
} from '../../src/features/charging/model.ts';
import { systemHealth } from '../../src/features/dashboard/model.ts';
import { eventsTimeline, searchSagas } from '../../src/features/observability/model.ts';
import { summarizeConnectors } from '../../src/features/stations/model.ts';
import { problematicSagas } from '../../src/features/transactions/model.ts';
import { toUiError } from '../../src/shared/api/errors.ts';
import { formatMoney, shortId } from '../../src/shared/format/format.ts';
import { connector, saga, station, step } from '../support/fixtures.ts';

describe('chargingFormSchema', () => {
  const values = { fleetId: '', stationId: 'st_1', connectorId: 'c1', energyKwh: '30.5' };

  it('convierte la energía a número y no exige flota al operador', () => {
    expect(chargingFormSchema(false).parse(values)).toMatchObject({ energyKwh: 30.5 });
  });

  it('exige una flota válida al administrador', () => {
    expect(chargingFormSchema(true).safeParse(values).success).toBe(false);
    expect(chargingFormSchema(true).safeParse({ ...values, fleetId: 'fleet_alfa' }).success).toBe(
      true,
    );
  });

  it.each([
    ['0', 'mayor que 0'],
    ['501', 'Máximo 500'],
    ['1.0001', '3 decimales'],
    ['abc', 'energía'],
  ])('rechaza energía %s', (energyKwh, message) => {
    const result = chargingFormSchema(false).safeParse({ ...values, energyKwh });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(message);
  });

  it('exige estación y conector', () => {
    const result = chargingFormSchema(false).safeParse({
      ...values,
      stationId: '',
      connectorId: '',
    });
    expect(result.error?.issues.map((i) => i.path[0])).toEqual(['stationId', 'connectorId']);
  });
});

describe('sagaTimeline y sagaOutcome', () => {
  it('una SAGA en curso muestra todos los pasos (los no iniciados como PENDING)', () => {
    const items = sagaTimeline(
      saga({ status: 'STARTED', steps: [step('RESERVATION', 'IN_PROGRESS')] }),
    );
    expect(items.map((i) => [i.key, i.status])).toEqual([
      ['RESERVATION', 'IN_PROGRESS'],
      ['DEBIT', 'PENDING'],
      ['ACTIVATION', 'PENDING'],
      ['CONFIRMATION', 'PENDING'],
    ]);
  });

  it('una SAGA compensada incluye el plan de compensación con su estado', () => {
    const compensated = saga({
      status: 'COMPENSATED',
      failureReason: 'CHARGER_HARDWARE_FAULT',
      compensationPlan: ['REFUND_DEBIT', 'RELEASE_RESERVATION'],
      steps: [
        step('RESERVATION', 'SUCCEEDED'),
        step('DEBIT', 'SUCCEEDED'),
        step('ACTIVATION', 'FAILED', 'CHARGER_HARDWARE_FAULT'),
        step('REFUND_DEBIT', 'SUCCEEDED'),
        step('RELEASE_RESERVATION', 'SUCCEEDED'),
      ],
    });
    expect(sagaTimeline(compensated).map((i) => i.key)).toEqual([
      'RESERVATION',
      'DEBIT',
      'ACTIVATION',
      'REFUND_DEBIT',
      'RELEASE_RESERVATION',
    ]);
    expect(sagaOutcome(compensated).tone).toBe('warning');
    expect(sagaOutcome(compensated).title).toContain('compensó');
    expect(sagaOutcome(compensated).description).toContain('falla de hardware');
  });

  it('describe cada estado terminal', () => {
    expect(sagaOutcome(saga({ status: 'COMPLETED' })).tone).toBe('success');
    expect(
      sagaOutcome(saga({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' })).description,
    ).toContain('Saldo insuficiente');
    expect(sagaOutcome(saga({ status: 'COMPENSATION_FAILED' })).tone).toBe('danger');
    expect(sagaOutcome(saga({ status: 'BILLING_COMPLETED' })).tone).toBe('info');
  });
});

describe('resúmenes', () => {
  it('cuenta conectores por estado', () => {
    expect(
      summarizeConnectors([
        station,
        { ...station, connectors: [connector('c9', 'OUT_OF_SERVICE')] },
      ]),
    ).toEqual({
      total: 4,
      available: 1,
      reserved: 1,
      occupied: 1,
      outOfService: 1,
    });
  });

  it('salud del sistema', () => {
    const up = { service: 'a', ready: true, latencyMs: 1 };
    const down = { service: 'b', ready: false, latencyMs: 1 };
    expect(systemHealth([up, up], false)).toBe('OPERATIONAL');
    expect(systemHealth([up, up], true)).toBe('DEGRADED');
    expect(systemHealth([up, down], false)).toBe('DEGRADED');
    expect(systemHealth([down, down], false)).toBe('DOWN');
  });

  it('filtra SAGAs con error o compensación', () => {
    const sagas = ['COMPLETED', 'COMPENSATED', 'FAILED', 'COMPENSATION_FAILED'].map((status) => ({
      ...saga({ status, sagaId: status }),
    }));
    expect(problematicSagas(sagas).map((s) => s.status)).toEqual([
      'COMPENSATED',
      'FAILED',
      'COMPENSATION_FAILED',
    ]);
  });

  it('busca por fragmento de sagaId o correlation_id', () => {
    const sagas = [
      saga({ status: 'COMPLETED', sagaId: 'saga_abc', correlationId: 'x1' }),
      saga({ status: 'FAILED', sagaId: 'saga_def', correlationId: 'CORR-zz' }),
    ];
    expect(searchSagas(sagas, 'abc').map((s) => s.sagaId)).toEqual(['saga_abc']);
    expect(searchSagas(sagas, 'corr-ZZ').map((s) => s.sagaId)).toEqual(['saga_def']);
    expect(searchSagas(sagas, '  ')).toHaveLength(2);
  });

  it('ordena los eventos por secuencia', () => {
    const items = eventsTimeline([
      {
        sequence: 2,
        type: 'STEP_FAILED',
        step: 'ACTIVATION',
        status: 'FAILED',
        attempt: 1,
        errorCode: 'CHARGER_HARDWARE_FAULT',
        occurredAt: '2026-11-13T10:00:02Z',
      },
      {
        sequence: 1,
        type: 'SAGA_STARTED',
        step: null,
        status: 'STARTED',
        attempt: null,
        errorCode: null,
        occurredAt: '2026-11-13T10:00:01Z',
      },
    ]);
    expect(items.map((i) => i.title)).toEqual(['SAGA iniciada', 'Paso fallido · ACTIVATION']);
    expect(items[1]?.detail).toContain('CHARGER_HARDWARE_FAULT');
  });
});

describe('toUiError', () => {
  it('usa el mensaje del código y conserva reason y correlation_id', () => {
    const error = new CombinedGraphQLErrors({
      errors: [
        {
          message: 'x',
          extensions: { code: 'FORBIDDEN', reason: 'FLEET_MISMATCH', correlationId: 'c-1' },
        },
      ],
    });
    expect(toUiError(error)).toEqual({
      message: 'No tiene permiso para esta operación.',
      code: 'FORBIDDEN',
      reason: 'FLEET_MISMATCH',
      correlationId: 'c-1',
    });
  });

  it('muestra el mensaje del backend para errores de dominio', () => {
    const error = new CombinedGraphQLErrors({
      errors: [{ message: 'Saldo insuficiente', extensions: { code: 'BAD_USER_INPUT' } }],
    });
    expect(toUiError(error).message).toBe('Saldo insuficiente');
  });

  it('errores HTTP y de red no exponen detalles internos', () => {
    const server = new ServerError('boom stack', {
      response: new Response(null, { status: 502 }),
      bodyText: 'trace',
    });
    expect(toUiError(server)).toMatchObject({ code: 'HTTP_502' });
    expect(toUiError(server).message).not.toContain('boom');
    expect(toUiError(new TypeError('Failed to fetch')).code).toBe('NETWORK_ERROR');
  });
});

describe('formato', () => {
  it('formatea unidades menores en pesos', () => {
    expect(formatMoney(3_000_000, 'COP').replace(/\s/g, ' ')).toBe('$ 30.000,00');
  });
  it('acorta ids largos', () => {
    expect(shortId('saga_0123456789abcdef')).toBe('saga_0123456789…');
    expect(shortId('corto')).toBe('corto');
  });
});
