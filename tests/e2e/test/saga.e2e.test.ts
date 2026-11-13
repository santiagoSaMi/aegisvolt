import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collect, save } from '../src/evidence.ts';
import { FLOCI_ENDPOINT, Stack, flociAvailable } from '../src/stack.ts';

const available = await flociAvailable();
if (!available && process.env.REQUIRE_INTEGRATION === 'true') {
  throw new Error(`Floci no responde en ${FLOCI_ENDPOINT} y REQUIRE_INTEGRATION=true`);
}

const STATION = 'st_e2e-norte-01';
const RICH = 'fleet_e2e-rica';
const POOR = 'fleet_e2e-pobre';

interface SagaView {
  sagaId: string;
  status: string;
  terminal: boolean;
  failureReason?: string;
  correlationId: string;
  reservationId: string;
  debitId: string;
  sessionId: string;
  compensationFailure?: { step: string; errorCode: string; nextAttemptAt?: string };
}

describe.skipIf(!available)(`SAGA Reservar y Activar Carga E2E (Floci ${FLOCI_ENDPOINT})`, () => {
  const stack = new Stack();
  let flagVersion = 1;

  const orchestrator = () => stack.url('saga-orchestrator');
  const startSaga = async (input: {
    key?: string;
    fleetId: string;
    connectorId: string;
    correlationId?: string;
  }) => {
    const key = input.key ?? randomUUID();
    const response = await fetch(`${orchestrator()}/v1/sagas`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        'x-correlation-id': input.correlationId ?? randomUUID(),
      },
      body: JSON.stringify({
        fleetId: input.fleetId,
        stationId: STATION,
        connectorId: input.connectorId,
        requestedEnergyKwh: 30,
      }),
    });
    return { key, status: response.status, view: (await response.json()) as SagaView };
  };
  const getSaga = async (sagaId: string) =>
    (await (await fetch(`${orchestrator()}/v1/sagas/${sagaId}`)).json()) as SagaView;
  const waitFor = async (sagaId: string, status: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await getSaga(sagaId);
      if (view.status === status || Date.now() > deadline) {
        return view;
      }
      await delay(250);
    }
  };
  const simulateFault = (enabled: boolean) => stack.setFlag(enabled, ++flagVersion);

  beforeAll(async () => {
    await stack.up();
    const station = await fetch(`${stack.url('station-reservation')}/v1/stations/${STATION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Estación E2E Norte',
        city: 'bogota',
        location: { latitude: 4.7, longitude: -74.05 },
        connectors: ['cn_01', 'cn_02', 'cn_03', 'cn_04', 'cn_05', 'cn_06'].map((connectorId) => ({
          connectorId,
          type: 'CCS2',
          maxPowerKw: 60,
        })),
      }),
    });
    expect(station.status).toBe(201);
    for (const [fleetId, amountMinor] of [
      [RICH, 50_000_000],
      [POOR, 1_000_000],
    ] as const) {
      const wallets = `${stack.url('billing-wallet')}/v1/wallets/${fleetId}`;
      await fetch(wallets, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const topUp = await fetch(`${wallets}/top-ups/tup_${randomUUID()}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: { amountMinor, currency: 'COP' } }),
      });
      expect(topUp.status).toBe(201);
    }
  });

  afterAll(async () => {
    await stack.down();
  });

  let completed: SagaView;
  let hardwareFault: SagaView;

  it('flujo exitoso: COMPLETED, reserva CONFIRMED, conector OCCUPIED, débito y sesión ACTIVE', async () => {
    const correlationId = randomUUID();
    const { status, view } = await startSaga({
      fleetId: RICH,
      connectorId: 'cn_01',
      correlationId,
    });
    completed = view;

    expect(status).toBe(201);
    expect(view).toMatchObject({ status: 'COMPLETED', correlationId });
    const evidence = await collect(stack, view.sagaId);
    save('01-exito', evidence);
    expect(evidence.saga).toMatchObject({ status: 'COMPLETED', connectorPowerKw: 60 });
    expect(evidence.reservation).toMatchObject({ status: 'CONFIRMED', sagaId: view.sagaId });
    expect(evidence.connector?.status).toBe('OCCUPIED');
    expect(evidence.debit).toMatchObject({ status: 'DEBITED', amountMinor: 3_000_000 });
    expect(evidence.ledger.map((e) => e.type)).toEqual(['DEBIT']);
    expect(evidence.session).toMatchObject({ status: 'ACTIVE' });
    // El correlation_id viaja a cada servicio y queda en sus registros.
    expect(evidence.ledger[0]?.correlationId).toBe(correlationId);
    expect(new Set(evidence.events.map((e) => e.correlationId))).toEqual(new Set([correlationId]));
  });

  it('repetición de la petición inicial: misma SAGA, ningún cobro adicional', async () => {
    const repeated = await startSaga({
      key: completed.sagaId.slice('saga_'.length),
      fleetId: RICH,
      connectorId: 'cn_01',
    });

    expect(repeated.status).toBe(201);
    expect(repeated.view.sagaId).toBe(completed.sagaId);
    expect(repeated.view.correlationId).toBe(completed.correlationId);
    const evidence = await collect(stack, completed.sagaId);
    expect(evidence.ledger).toHaveLength(1);
    expect(evidence.wallet?.balanceMinor).toBe(47_000_000);
  });

  it('fondos insuficientes: libera la reserva → COMPENSATED; saldo intacto', async () => {
    const { view } = await startSaga({ fleetId: POOR, connectorId: 'cn_02' });

    expect(view).toMatchObject({ status: 'COMPENSATED', failureReason: 'INSUFFICIENT_FUNDS' });
    const evidence = await collect(stack, view.sagaId);
    save('02-fondos-insuficientes', evidence);
    expect(evidence.reservation?.status).toBe('RELEASED');
    expect(evidence.connector?.status).toBe('AVAILABLE');
    expect(evidence.debit?.status).toBe('REJECTED_INSUFFICIENT_FUNDS');
    expect(evidence.ledger).toHaveLength(0);
    expect(evidence.wallet?.balanceMinor).toBe(1_000_000);
    expect(evidence.session).toBeUndefined();
  });

  it('fallo de hardware (flag en la tabla de flags): reembolso y luego liberación → COMPENSATED', async () => {
    await simulateFault(true);
    try {
      const { view } = await startSaga({ fleetId: RICH, connectorId: 'cn_03' });
      hardwareFault = view;

      expect(view).toMatchObject({
        status: 'COMPENSATED',
        failureReason: 'CHARGER_HARDWARE_FAULT',
      });
      const evidence = await collect(stack, view.sagaId);
      save('03-fallo-hardware', evidence);
      expect(evidence.session).toMatchObject({
        status: 'FAILED',
        faultCode: 'E-HW-001',
        faultSimulated: true,
      });
      expect(evidence.debit).toMatchObject({ status: 'REFUNDED' });
      expect(evidence.refund).toMatchObject({ amountMinor: 3_000_000 });
      expect(evidence.ledger.map((e) => e.type)).toEqual(['DEBIT', 'REFUND']);
      expect(evidence.reservation?.status).toBe('RELEASED');
      expect(evidence.connector?.status).toBe('AVAILABLE');
      expect(evidence.wallet?.balanceMinor).toBe(47_000_000);
      // Orden: el reembolso se verificó ANTES de liberar.
      const order = evidence.events
        .filter((e) => e.type === 'COMPENSATION_SUCCEEDED')
        .map((e) => e.step);
      expect(order).toEqual(['REFUND_DEBIT', 'RELEASE_RESERVATION']);
    } finally {
      await simulateFault(false);
    }
  });

  it('repetición de una compensación: el servicio responde ALREADY_* y no cambia nada', async () => {
    const headers = {
      'content-type': 'application/json',
      'x-correlation-id': hardwareFault.correlationId,
      'x-saga-id': hardwareFault.sagaId,
    };
    const before = await collect(stack, hardwareFault.sagaId);

    const refund = await fetch(
      `${stack.url('billing-wallet')}/v1/debits/${hardwareFault.debitId}/refund`,
      { method: 'POST', headers, body: JSON.stringify({ reason: 'CHARGER_HARDWARE_FAULT' }) },
    );
    const release = await fetch(
      `${stack.url('station-reservation')}/v1/reservations/${hardwareFault.reservationId}/release`,
      { method: 'POST', headers, body: JSON.stringify({ reason: 'CHARGER_HARDWARE_FAULT' }) },
    );

    expect(await refund.json()).toMatchObject({ outcome: 'ALREADY_REFUNDED' });
    expect(await release.json()).toMatchObject({ outcome: 'ALREADY_RELEASED' });
    const after = await collect(stack, hardwareFault.sagaId);
    expect(after.wallet?.balanceMinor).toBe(before.wallet?.balanceMinor);
    expect(after.ledger).toHaveLength(before.ledger.length);
    save('04-compensacion-repetida', after);
  });

  it('reinicio con paso intermedio persistido: SIGKILL durante el débito y reanudación', async () => {
    stack.proxy.holdDebitResponse = true;
    const held = stack.proxy.waitForHeldDebit();
    const key = randomUUID();
    const sagaId = `saga_${key}`;
    const request = startSaga({ key, fleetId: RICH, connectorId: 'cn_04' }).catch(() => undefined);

    await held; // billing YA aplicó el débito; el orquestador no recibió la respuesta
    await stack.stop('saga-orchestrator', 'SIGKILL');
    await request;
    const persisted = await collect(stack, sagaId);
    save('05a-reinicio-antes', persisted);
    expect(persisted.saga).toMatchObject({
      status: 'RESERVATION_COMPLETED',
      steps: { DEBIT: { status: 'IN_PROGRESS', attempts: 1 } },
    });
    expect(persisted.debit?.status).toBe('DEBITED');

    await stack.start('saga-orchestrator'); // nuevo proceso: el worker la retoma
    const view = await waitFor(sagaId, 'COMPLETED');

    expect(view.status).toBe('COMPLETED');
    const evidence = await collect(stack, sagaId);
    save('05b-reinicio-despues', evidence);
    expect(evidence.events.map((e) => e.type)).toContain('RECOVERED');
    // El débito repetido con la misma clave no cobró dos veces.
    expect(evidence.ledger.map((e) => e.type)).toEqual(['DEBIT']);
    expect(evidence.session?.status).toBe('ACTIVE');
  });

  it('fallo durante la compensación: COMPENSATION_FAILED y recuperación tras reiniciar', async () => {
    await simulateFault(true);
    stack.proxy.failRefunds = true;
    let sagaId: string;
    try {
      const { status, view } = await startSaga({ fleetId: RICH, connectorId: 'cn_05' });
      sagaId = view.sagaId;

      expect(status).toBe(202);
      expect(view).toMatchObject({
        status: 'COMPENSATION_FAILED',
        compensationFailure: { step: 'REFUND_DEBIT', errorCode: 'SERVICE_UNAVAILABLE' },
      });
      expect(view.compensationFailure?.nextAttemptAt).toBeDefined();
      const failed = await collect(stack, sagaId);
      save('06a-compensacion-fallida', failed);
      // No se marcó compensada: el débito sigue cobrado y la reserva retenida.
      expect(failed.debit?.status).toBe('DEBITED');
      expect(failed.reservation?.status).toBe('HELD');

      // El orquestador se reinicia; billing vuelve a responder.
      await stack.stop('saga-orchestrator', 'SIGKILL');
    } finally {
      await simulateFault(false);
      stack.proxy.failRefunds = false;
    }
    await stack.start('saga-orchestrator');
    const view = await waitFor(sagaId, 'COMPENSATED');

    expect(view.status).toBe('COMPENSATED');
    const evidence = await collect(stack, sagaId);
    save('06b-compensacion-recuperada', evidence);
    expect(evidence.debit?.status).toBe('REFUNDED');
    expect(evidence.reservation?.status).toBe('RELEASED');
    expect(evidence.events.map((e) => e.type)).toContain('COMPENSATION_RETRY_REQUESTED');
  });
});
