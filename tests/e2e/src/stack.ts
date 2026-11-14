// Stack E2E: los cuatro servicios REALES (procesos Node) contra Floci, con
// tablas temporales propias. Nunca apunta a AWS real: el endpoint debe ser local
// y las credenciales son las ficticias del emulador.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_FLAG_CATALOG,
  featureFlagKeys,
  featureFlagsTableDefinition,
} from '@aegisvolt/feature-flags';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { CognitoFixture, type TestUser } from './cognito.ts';

export const FLOCI_ENDPOINT = process.env.E2E_AWS_ENDPOINT_URL ?? 'http://localhost:4566';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(FLOCI_ENDPOINT)) {
  throw new Error(`E2E_AWS_ENDPOINT_URL debe ser local: ${FLOCI_ENDPOINT}`);
}
const FAKE_AWS = {
  AWS_ENDPOINT_URL: FLOCI_ENDPOINT,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
};
Object.assign(process.env, FAKE_AWS);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const EVIDENCE_DIR = resolve(ROOT, 'tests/e2e/.evidence');

export async function flociAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${FLOCI_ENDPOINT}/_floci/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type ServiceName =
  | 'station-reservation'
  | 'billing-wallet'
  | 'energy-dispatch'
  | 'saga-orchestrator'
  | 'graphql-api';

/** Usuarios de Cognito del stack E2E (flotas propias de las pruebas GraphQL). */
export const E2E_USERS = {
  admin: { username: 'e2e-admin', group: 'platform-admins' },
  operatorAlfa: { username: 'e2e-op-alfa', group: 'fleet-operators', fleetId: 'fleet_gql-alfa' },
  operatorBeta: { username: 'e2e-op-beta', group: 'fleet-operators', fleetId: 'fleet_gql-beta' },
} as const satisfies Record<string, TestUser>;

/**
 * Puertos fijos POR DEBAJO del rango efímero de Linux (32768–60999): un puerto
 * de ese rango puede estar ocupado por un socket saliente (p. ej. hacia Floci).
 */
const PORTS: Record<ServiceName, number> = {
  'saga-orchestrator': 24100,
  'station-reservation': 24101,
  'billing-wallet': 24102,
  'energy-dispatch': 24103,
  'graphql-api': 24104,
};

const dirOf = (name: ServiceName) =>
  name === 'graphql-api' ? join(ROOT, 'apps', name) : join(ROOT, 'services', name);

export interface Tables {
  readonly sagas: string;
  readonly reservations: string;
  readonly billing: string;
  readonly dispatch: string;
  readonly flags: string;
}

/**
 * Proxy HTTP delante de billing-wallet para inyectar fallos de forma
 * controlada (no se toca el código del servicio):
 * - `failRefunds`: los reembolsos responden 503 (fallo transitorio de la compensación);
 * - `holdDebitResponse`: reenvía el débito a billing (se aplica) pero retiene la
 *   respuesta, para matar al orquestador con el paso persistido IN_PROGRESS.
 */
export class FaultInjectingProxy {
  failRefunds = false;
  holdDebitResponse = false;
  private server: Server | undefined;
  private readonly held: ServerResponse[] = [];
  private onHeld: (() => void) | undefined;
  readonly target: string;

  constructor(target: string) {
    this.target = target;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.listen(0, '127.0.0.1');
    await new Promise((ok) => this.server?.once('listening', ok));
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  /** Espera a que llegue (y se aplique) un débito retenido. */
  waitForHeldDebit(): Promise<void> {
    return new Promise((ok) => {
      this.onHeld = ok;
    });
  }

  async stop(): Promise<void> {
    for (const res of this.held.splice(0)) {
      res.destroy();
    }
    this.server?.closeAllConnections();
    await new Promise((ok) => this.server?.close(ok));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const url = req.url ?? '/';
    if (this.failRefunds && url.endsWith('/refund')) {
      res.writeHead(503, { 'content-type': 'application/problem+json' });
      res.end(
        JSON.stringify({
          type: 'urn:aegisvolt:problem:service_unavailable',
          title: 'Service unavailable',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
        }),
      );
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== 'host',
      ),
    );
    const upstream = await fetch(`${this.target}${url}`, {
      method: req.method ?? 'GET',
      headers,
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (this.holdDebitResponse && req.method === 'PUT' && url.startsWith('/v1/debits/')) {
      this.holdDebitResponse = false;
      this.held.push(res); // el débito YA se aplicó en billing; la respuesta nunca llega
      this.onHeld?.();
      return;
    }
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(body);
  }
}

/** Los cuatro servicios + tablas temporales + proxy de fallos. */
export class Stack {
  readonly tables: Tables;
  readonly db: DynamoDBDocumentClient;
  readonly proxy: FaultInjectingProxy;
  private readonly client: DynamoDBClient;
  private readonly processes = new Map<ServiceName, ChildProcess>();
  private billingProxyUrl = '';
  private cognitoFixture: CognitoFixture | undefined;

  constructor() {
    const suffix = randomUUID().slice(0, 8);
    this.tables = {
      sagas: `aegisvolt-sagas-e2e-${suffix}`,
      reservations: `aegisvolt-reservations-e2e-${suffix}`,
      billing: `aegisvolt-billing-e2e-${suffix}`,
      dispatch: `aegisvolt-dispatch-e2e-${suffix}`,
      flags: `aegisvolt-feature-flags-e2e-${suffix}`,
    };
    this.client = new DynamoDBClient({ region: 'us-east-1', endpoint: FLOCI_ENDPOINT });
    this.db = DynamoDBDocumentClient.from(this.client);
    this.proxy = new FaultInjectingProxy(this.url('billing-wallet'));
    mkdirSync(join(EVIDENCE_DIR, 'logs'), { recursive: true });
  }

  url(service: ServiceName): string {
    return `http://127.0.0.1:${String(PORTS[service])}`;
  }

  async up(): Promise<void> {
    await Promise.all([
      this.createServiceTable('saga-orchestrator', this.tables.sagas),
      this.createServiceTable('station-reservation', this.tables.reservations),
      this.createServiceTable('billing-wallet', this.tables.billing),
      this.createServiceTable('energy-dispatch', this.tables.dispatch),
      this.createFlagsTable(),
    ]);
    await this.seedFlags();
    this.cognitoFixture = await CognitoFixture.create(FLOCI_ENDPOINT, Object.values(E2E_USERS));
    this.billingProxyUrl = await this.proxy.start();
    await Promise.all([
      this.start('station-reservation'),
      this.start('billing-wallet'),
      this.start('energy-dispatch'),
    ]);
    await this.start('saga-orchestrator');
    await this.start('graphql-api');
  }

  /** Cognito del stack (pool, client y tokens reales de Floci). */
  get cognito(): CognitoFixture {
    if (this.cognitoFixture === undefined) {
      throw new Error('El stack no está levantado');
    }
    return this.cognitoFixture;
  }

  /** Siembra las flags del catálogo en `false` (valores explícitos de las E2E). */
  private async seedFlags(): Promise<void> {
    for (const definition of FEATURE_FLAG_CATALOG) {
      await this.db.send(
        new PutCommand({
          TableName: this.tables.flags,
          Item: {
            ...featureFlagKeys.flag(definition.key),
            key: definition.key,
            enabled: false,
            description: definition.description,
            version: 1,
            updatedAt: new Date().toISOString(),
            updatedBy: 'e2e-seed',
          },
        }),
      );
    }
  }

  async down(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((name) => this.stop(name)));
    await this.proxy.stop();
    await this.cognitoFixture?.delete();
    if (process.env.E2E_KEEP_TABLES !== 'true') {
      await Promise.allSettled(
        (Object.values(this.tables) as string[]).map((TableName) =>
          this.client.send(new DeleteTableCommand({ TableName })),
        ),
      );
    }
    this.client.destroy();
  }

  /** Cambia `SIMULATE_CHARGER_HARDWARE_FAULT` en la tabla de flags del ambiente E2E. */
  async setFlag(enabled: boolean, version: number): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.tables.flags,
        Item: {
          ...featureFlagKeys.flag('SIMULATE_CHARGER_HARDWARE_FAULT'),
          key: 'SIMULATE_CHARGER_HARDWARE_FAULT',
          enabled,
          version,
          updatedAt: new Date().toISOString(),
          description: FEATURE_FLAG_CATALOG.find((d) => d.key === 'SIMULATE_CHARGER_HARDWARE_FAULT')
            ?.description,
          updatedBy: 'e2e',
        },
      }),
    );
  }

  /** Arranca un servicio como proceso real y espera a su readiness. */
  async start(name: ServiceName): Promise<void> {
    const log = createWriteStream(join(EVIDENCE_DIR, 'logs', `${name}.log`), { flags: 'a' });
    const child = spawn(process.execPath, ['src/main.ts'], {
      cwd: dirOf(name),
      env: { ...process.env, ...this.envFor(name) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    this.processes.set(name, child);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const ready = await fetch(`${this.url(name)}/health/ready`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ready) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(`${name} terminó al arrancar (código ${String(child.exitCode)})`);
      }
      await delay(200);
    }
    throw new Error(`${name} no quedó listo a tiempo`);
  }

  /** Apagado ordenado (SIGTERM) o caída abrupta (SIGKILL: simula un reinicio del pod). */
  async stop(name: ServiceName, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.processes.get(name);
    if (child?.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise((ok) => child.once('exit', ok));
    child.kill(signal);
    await exited;
    this.processes.delete(name);
  }

  private envFor(name: ServiceName): Record<string, string> {
    const common = {
      ...FAKE_AWS,
      APP_ENV: 'local',
      SERVICE_VERSION: 'e2e',
      LOG_LEVEL: 'info',
      PORT: String(PORTS[name]),
    };
    switch (name) {
      case 'station-reservation':
        return {
          ...common,
          DYNAMODB_TABLE_NAME: this.tables.reservations,
          FEATURE_FLAGS_TABLE_NAME: this.tables.flags,
        };
      case 'billing-wallet':
        return {
          ...common,
          DYNAMODB_TABLE_NAME: this.tables.billing,
          FEATURE_FLAGS_TABLE_NAME: this.tables.flags,
        };
      case 'energy-dispatch':
        return {
          ...common,
          DYNAMODB_TABLE_NAME: this.tables.dispatch,
          FEATURE_FLAGS_TABLE_NAME: this.tables.flags,
          FEATURE_FLAGS_CACHE_TTL_MS: '0',
        };
      case 'saga-orchestrator':
        return {
          ...common,
          DYNAMODB_TABLE_NAME: this.tables.sagas,
          STATION_RESERVATION_URL: this.url('station-reservation'),
          BILLING_WALLET_URL: this.billingProxyUrl,
          ENERGY_DISPATCH_URL: this.url('energy-dispatch'),
          // Tiempos cortos para que la demostración sea rápida (misma lógica).
          SAGA_STEP_TIMEOUT_MS: '1500',
          SAGA_FORWARD_MAX_ATTEMPTS: '2',
          SAGA_FORWARD_BASE_DELAY_MS: '50',
          SAGA_FORWARD_MAX_DELAY_MS: '200',
          SAGA_COMPENSATION_ATTEMPTS: '2',
          SAGA_COMPENSATION_MAX_ROUNDS: '5',
          SAGA_COMPENSATION_BASE_DELAY_MS: '500',
          SAGA_COMPENSATION_MAX_DELAY_MS: '1000',
          SAGA_LEASE_MS: '4000',
          RECOVERY_STALE_AFTER_MS: '3200',
          RECOVERY_INTERVAL_MS: '500',
          SAGA_SYNC_WAIT_MS: '15000',
          HTTP_REQUEST_TIMEOUT_MS: '20000',
          SHUTDOWN_GRACE_MS: '25000',
        };
      case 'graphql-api':
        return {
          ...common,
          FEATURE_FLAGS_TABLE_NAME: this.tables.flags,
          FEATURE_FLAGS_CACHE_TTL_MS: '0',
          STATION_RESERVATION_URL: this.url('station-reservation'),
          BILLING_WALLET_URL: this.url('billing-wallet'),
          ENERGY_DISPATCH_URL: this.url('energy-dispatch'),
          SAGA_ORCHESTRATOR_URL: this.url('saga-orchestrator'),
          // El `iss` de Floci usa el hostname `floci`; el JWKS se lee por localhost.
          COGNITO_ISSUER: `http://floci:4566/${this.cognito.poolId}`,
          COGNITO_JWKS_URL: `${FLOCI_ENDPOINT}/${this.cognito.poolId}/.well-known/jwks.json`,
          COGNITO_CLIENT_ID: this.cognito.clientId,
          SAGA_START_TIMEOUT_MS: '20000',
          SHUTDOWN_GRACE_MS: '25000',
        };
    }
  }

  private async createServiceTable(service: ServiceName, tableName: string): Promise<void> {
    const child = spawn(process.execPath, ['scripts/create-local-table.ts'], {
      cwd: join(ROOT, 'services', service),
      env: { ...process.env, ...FAKE_AWS, DYNAMODB_TABLE_NAME: tableName },
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((ok) => child.once('exit', ok));
    if (code !== 0) {
      throw new Error(`No se pudo crear la tabla ${tableName} (${service})`);
    }
  }

  private async createFlagsTable(): Promise<void> {
    await this.client.send(new CreateTableCommand(featureFlagsTableDefinition(this.tables.flags)));
    await waitUntilTableExists(
      { client: this.client, maxWaitTime: 30 },
      { TableName: this.tables.flags },
    );
  }
}
