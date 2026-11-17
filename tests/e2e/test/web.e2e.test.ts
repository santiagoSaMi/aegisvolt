// E2E de la consola web en un navegador real (Chromium headless vía
// playwright-core): SPA compilada → proxies del mismo origen → graphql-api →
// servicios → DynamoDB/Cognito en Floci. Sin mocks.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { featureFlagKeys } from '@aegisvolt/feature-flags';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { E2E_USERS, EVIDENCE_DIR, FLOCI_ENDPOINT, Stack, flociAvailable } from '../src/stack.ts';
import { WebConsoleServer, buildWebConsole } from '../src/web-console.ts';

const available = await flociAvailable();
if (!available && process.env.REQUIRE_INTEGRATION === 'true') {
  throw new Error(`Floci no responde en ${FLOCI_ENDPOINT} y REQUIRE_INTEGRATION=true`);
}

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web');
const SCREENSHOTS = join(EVIDENCE_DIR, 'web');
const WEB_PORT = 24105;
const STATION = 'st_web-norte-01';
const STATION_NAME = 'Estación Web Norte';

describe.skipIf(!available)(`Consola web en navegador (Floci ${FLOCI_ENDPOINT})`, () => {
  const stack = new Stack();
  let web: WebConsoleServer | undefined;
  let baseUrl = '';
  let browser: Browser | undefined;

  async function newPage(): Promise<Page> {
    if (browser === undefined) {
      throw new Error('El navegador no está iniciado');
    }
    const context = await browser.newContext({
      locale: 'es-CO',
      viewport: { width: 1360, height: 900 },
    });
    return context.newPage();
  }

  async function login(page: Page, username: string): Promise<void> {
    await page.goto(`${baseUrl}/#/login`);
    await page.getByLabel('Usuario').fill(username);
    await page.getByLabel('Contraseña').fill(stack.cognito.password);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await page.getByTestId('environment-badge').waitFor();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  }

  async function startCharging(page: Page, connectorId: string): Promise<void> {
    await page.getByRole('link', { name: 'Carga', exact: true }).click();
    await page.getByRole('heading', { name: 'Carga', exact: true }).waitFor();
    await page.getByLabel('Estación', { exact: true }).selectOption(STATION);
    await page.getByLabel('Conector', { exact: true }).selectOption(connectorId);
    await page.getByLabel('Energía solicitada (kWh)').fill('10');
    await page.getByTestId('estimate').waitFor();
    await page.getByRole('button', { name: 'Iniciar carga' }).click();
    await page.getByTestId('saga-progress').waitFor();
  }

  const sagaStatus = (page: Page) => page.getByTestId('saga-progress').getAttribute('data-status');

  beforeAll(async () => {
    mkdirSync(SCREENSHOTS, { recursive: true });
    const distDir = buildWebConsole(WEB_DIR);
    await stack.up();
    const station = await fetch(`${stack.url('station-reservation')}/v1/stations/${STATION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: STATION_NAME,
        city: 'medellin',
        location: { latitude: 6.25, longitude: -75.56 },
        connectors: ['cn_01', 'cn_02', 'cn_03'].map((connectorId) => ({
          connectorId,
          type: 'CCS2',
          maxPowerKw: 60,
        })),
      }),
    });
    expect(station.status).toBe(201);
    for (const fleetId of [E2E_USERS.operatorAlfa.fleetId, E2E_USERS.operatorBeta.fleetId]) {
      const wallet = `${stack.url('billing-wallet')}/v1/wallets/${fleetId}`;
      await fetch(wallet, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await fetch(`${wallet}/top-ups/tup_${randomUUID()}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: { amountMinor: 20_000_000, currency: 'COP' } }),
      });
    }
    web = new WebConsoleServer({
      distDir,
      port: WEB_PORT,
      // config.json del "despliegue": el ambiente NO lo elige el navegador.
      runtimeConfig: {
        environment: 'local',
        graphqlUrl: './graphql',
        auth: { cognitoUrl: './auth/cognito', clientId: stack.cognito.clientId },
        pollingIntervalMs: 1000,
        cities: ['medellin'],
      },
      graphqlTarget: stack.url('graphql-api'),
      cognitoTarget: FLOCI_ENDPOINT,
    });
    baseUrl = await web.start();
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await web?.stop();
    await stack.down();
  });

  it('credenciales inválidas: Cognito las rechaza y la consola lo informa', async () => {
    const page = await newPage();
    await page.goto(`${baseUrl}/#/login`);
    await page.getByLabel('Usuario').fill(E2E_USERS.operatorAlfa.username);
    await page.getByLabel('Contraseña').fill('incorrecta-123');
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect
      .poll(() => page.getByRole('alert').textContent())
      .toContain('Usuario o contraseña incorrectos');
    await page.close();
  });

  it('flujo exitoso: un operador reserva y activa una carga y ve la SAGA COMPLETED', async () => {
    const page = await newPage();
    await login(page, E2E_USERS.operatorAlfa.username);

    // Ambiente informado por el backend y visible; no hay selector de ambiente.
    expect(await page.getByTestId('environment-badge').textContent()).toBe('Ambiente: LOCAL');
    expect(await page.getByLabel(/ambiente/i).count()).toBe(0);
    await page
      .getByRole('table', { name: 'Conectores por estación' })
      .getByText(STATION_NAME)
      .first()
      .waitFor();

    await startCharging(page, 'cn_01');
    await expect.poll(() => sagaStatus(page), { timeout: 30_000 }).toBe('COMPLETED');
    expect(await page.getByTestId('saga-progress').textContent()).toContain('Carga iniciada');
    await page.screenshot({ path: join(SCREENSHOTS, '01-carga-completada.png'), fullPage: true });

    // El débito aparece en el historial (estado leído del backend).
    await page.getByRole('link', { name: 'Transacciones' }).click();
    await page
      .getByRole('table', { name: 'Movimientos de la billetera' })
      .getByText('Débito')
      .waitFor();
    await page.screenshot({ path: join(SCREENSHOTS, '02-transacciones.png'), fullPage: true });
    await page.close();
  });

  it('flujo fallido: un admin activa la falla simulada y la carga del operador se compensa', async () => {
    const admin = await newPage();
    await login(admin, E2E_USERS.admin.username);
    await admin.getByRole('link', { name: 'Feature flags' }).click();
    await admin.getByRole('switch', { name: 'SIMULATE_CHARGER_HARDWARE_FAULT: activar' }).click();
    await admin
      .getByRole('dialog', { name: 'Confirmar cambio de flag' })
      .getByRole('button', { name: 'Activar' })
      .click();
    await admin.getByText('Flag SIMULATE_CHARGER_HARDWARE_FAULT actualizada').waitFor();
    await admin.screenshot({ path: join(SCREENSHOTS, '03-flag-activada.png'), fullPage: true });

    // El cambio quedó en la tabla de flags del ambiente (sin redesplegar).
    const stored = await stack.db.send(
      new GetCommand({
        TableName: stack.tables.flags,
        Key: featureFlagKeys.flag('SIMULATE_CHARGER_HARDWARE_FAULT'),
      }),
    );
    expect(stored.Item).toMatchObject({ enabled: true, version: 2 });
    await admin.close();

    const operator = await newPage();
    await login(operator, E2E_USERS.operatorBeta.username);
    // Un operador ve las flags, pero no puede editarlas.
    await operator.getByRole('link', { name: 'Feature flags' }).click();
    await operator.getByText('SIMULATE_CHARGER_HARDWARE_FAULT').waitFor();
    expect(await operator.getByRole('switch').count()).toBe(0);

    await startCharging(operator, 'cn_02');
    await expect.poll(() => sagaStatus(operator), { timeout: 30_000 }).toBe('COMPENSATED');
    const progress = (await operator.getByTestId('saga-progress').textContent()) ?? '';
    expect(progress).toContain('La operación no se completó y se compensó');
    expect(progress).toContain('falla de hardware');
    await operator.screenshot({
      path: join(SCREENSHOTS, '04-carga-compensada.png'),
      fullPage: true,
    });

    // Observabilidad: historial con correlation_id y compensaciones.
    await operator.getByRole('link', { name: /Ver el historial completo/ }).click();
    const correlationId = (await operator.getByTestId('saga-correlation-id').textContent()) ?? '';
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    await operator.getByText('REFUND_DEBIT → RELEASE_RESERVATION').waitFor();
    await operator
      .getByRole('list', { name: 'Eventos de la SAGA' })
      .getByText(/Paso fallido · ACTIVATION/)
      .waitFor();
    await operator.screenshot({ path: join(SCREENSHOTS, '05-observabilidad.png'), fullPage: true });

    // Transacciones: débito + reembolso y la operación compensada.
    await operator.getByRole('link', { name: 'Transacciones' }).click();
    const movements = operator.getByRole('table', { name: 'Movimientos de la billetera' });
    await movements.getByText('Reembolso').waitFor();
    await operator
      .getByRole('table', { name: 'Operaciones con error o compensación' })
      .getByText('Compensada')
      .waitFor();
    await operator.close();
  });
});
