// Demo interactiva de la consola web contra Floci: levanta el mismo stack que
// las E2E (tablas temporales, User Pool de prueba, cuatro servicios y
// graphql-api), siembra datos y sirve la SPA hasta Ctrl+C (entonces limpia).
// Solo credenciales ficticias del emulador.
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2E_USERS, FLOCI_ENDPOINT, Stack, flociAvailable } from './stack.ts';
import { WebConsoleServer, buildWebConsole } from './web-console.ts';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web');
const PORT = Number(process.env.DEMO_WEB_PORT ?? '24105');

const STATIONS = [
  {
    stationId: 'st_demo-medellin-01',
    name: 'Estación Poblado',
    city: 'medellin',
    lat: 6.21,
    lon: -75.57,
  },
  {
    stationId: 'st_demo-medellin-02',
    name: 'Estación Laureles',
    city: 'medellin',
    lat: 6.24,
    lon: -75.59,
  },
  {
    stationId: 'st_demo-bogota-01',
    name: 'Estación Chapinero',
    city: 'bogota',
    lat: 4.65,
    lon: -74.06,
  },
];

/** Salida para la persona que ejecuta la demo (no es logging de servicio). */
const log = (message: string) => process.stdout.write(`${message}\n`);

if (!(await flociAvailable())) {
  log(`Floci no responde en ${FLOCI_ENDPOINT}. Ejecute scripts/floci/start.sh`);
  process.exit(1);
}

const stack = new Stack();
const state: { web: WebConsoleServer | undefined; stopping: boolean } = {
  web: undefined,
  stopping: false,
};

async function shutdown(): Promise<void> {
  if (state.stopping) return;
  state.stopping = true;
  log('\nDeteniendo y limpiando (tablas temporales y User Pool)…');
  await state.web?.stop();
  await stack.down();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

log('Compilando la consola…');
const distDir = buildWebConsole(WEB_DIR);
log('Levantando tablas, Cognito y servicios…');
await stack.up();

for (const s of STATIONS) {
  const response = await fetch(`${stack.url('station-reservation')}/v1/stations/${s.stationId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: s.name,
      city: s.city,
      location: { latitude: s.lat, longitude: s.lon },
      connectors: [
        { connectorId: 'cn_01', type: 'CCS2', maxPowerKw: 60 },
        { connectorId: 'cn_02', type: 'CCS2', maxPowerKw: 150 },
        { connectorId: 'cn_03', type: 'TYPE2', maxPowerKw: 22 },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`No se pudo crear ${s.stationId}: HTTP ${String(response.status)}`);
}
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
    body: JSON.stringify({ amount: { amountMinor: 50_000_000, currency: 'COP' } }),
  });
}

state.web = new WebConsoleServer({
  distDir,
  port: PORT,
  runtimeConfig: {
    environment: 'local',
    graphqlUrl: './graphql',
    auth: { cognitoUrl: './auth/cognito', clientId: stack.cognito.clientId },
    pollingIntervalMs: 2000,
    cities: ['medellin', 'bogota'],
  },
  graphqlTarget: stack.url('graphql-api'),
  cognitoTarget: FLOCI_ENDPOINT,
});
const url = await state.web.start();

log(`
Consola lista: ${url}

  Contraseña (todos): ${stack.cognito.password}
  ${E2E_USERS.operatorAlfa.username.padEnd(14)} operador · ${E2E_USERS.operatorAlfa.fleetId} (saldo $500.000)
  ${E2E_USERS.operatorBeta.username.padEnd(14)} operador · ${E2E_USERS.operatorBeta.fleetId} (saldo $500.000)
  ${E2E_USERS.admin.username.padEnd(14)} administrador de plataforma

Logs de los servicios: tests/e2e/.evidence/logs/
Ctrl+C para detener y limpiar.`);
