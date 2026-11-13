import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { billingWalletV1 } from '@aegisvolt/contracts';
import { createLogger } from '@aegisvolt/logger';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConcurrentModificationError } from '../../src/application/index.ts';
import { createUseCases } from '../../src/composition.ts';
import {
  DebitId,
  Energy,
  FleetId,
  OperationAudit,
  PricingPolicy,
  SagaId,
  debitEstimatedCharge,
} from '../../src/domain/index.ts';
import { DynamoDbWalletRepository } from '../../src/infrastructure/dynamodb/dynamodb-wallet-repository.ts';
import { createDynamoDbReadinessCheck } from '../../src/infrastructure/dynamodb/readiness.ts';
import { GSI1, keys } from '../../src/infrastructure/dynamodb/table.ts';
import { StaticFeatureFlagReader } from '../../src/infrastructure/feature-flags/static-feature-flag-reader.ts';
import { createHttpApp } from '../../src/presentation/http/app.ts';
import { DEBIT_AMOUNT, PRICING, START } from '../support/fixtures.ts';
import { FixedClock } from '../support/in-memory-wallet-repository.ts';
import {
  FLOCI_ENDPOINT,
  createClients,
  createTemporaryTable,
  deleteTable,
  flociAvailable,
} from './floci.ts';

const CORRELATION_ID = '3f2c1e5a-1b2c-4d3e-8f90-123456789abc';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sagaId = (n: number) => `saga_${uuid(n)}`;
const debitId = (n: number) => `dbt_${uuid(n)}`;

describe.skipIf(!flociAvailable)(
  `billing-wallet contra DynamoDB de Floci (${FLOCI_ENDPOINT})`,
  () => {
    const clients = createClients();
    const clock = new FixedClock(START);
    let tableName: string;
    let server: Server;
    let url: string;

    const raw = async (key: { PK: string; SK: string }) =>
      (
        await clients.documentClient.send(
          new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
        )
      ).Item as Record<string, unknown> | undefined;
    const balanceOf = async (fleetId: string) => (await raw(keys.wallet(fleetId)))?.balanceMinor;
    const ledgerOf = async (fleetId: string) =>
      ((
        await clients.documentClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tx)',
            ExpressionAttributeValues: { ':pk': keys.walletPartition(fleetId), ':tx': 'TX#' },
            ConsistentRead: true,
          }),
        )
      ).Items as Record<string, unknown>[] | undefined) ?? [];

    const headers = (saga: string) => ({
      'content-type': 'application/json',
      'x-correlation-id': CORRELATION_ID,
      'x-saga-id': saga,
    });
    const putDebit = (fleetId: string, n: number, energyKwh = 30) =>
      fetch(`${url}/v1/debits/${debitId(n)}`, {
        method: 'PUT',
        headers: headers(sagaId(n)),
        body: JSON.stringify({ sagaId: sagaId(n), fleetId, energyKwh, connectorPowerKw: 60 }),
      });
    const refund = (n: number, saga = sagaId(n)) =>
      fetch(`${url}/v1/debits/${debitId(n)}/refund`, {
        method: 'POST',
        headers: headers(saga),
        body: JSON.stringify({ reason: 'CHARGER_HARDWARE_FAULT' }),
      });
    const problemCode = async (response: Response) =>
      billingWalletV1.problemSchema.parse(await response.json()).code;

    /** Abre una billetera y la recarga por HTTP. */
    async function fund(fleetId: string, amountMinor: number): Promise<void> {
      expect((await fetch(`${url}/v1/wallets/${fleetId}`, { method: 'PUT' })).status).toBe(201);
      const topUp = await fetch(
        `${url}/v1/wallets/${fleetId}/top-ups/tup_seed-${fleetId.slice(6)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-correlation-id': CORRELATION_ID },
          body: JSON.stringify({ amount: { amountMinor, currency: 'COP' } }),
        },
      );
      expect(topUp.status).toBe(201);
      clock.advance(1_000);
    }

    beforeAll(async () => {
      tableName = await createTemporaryTable(clients);
      const app = createHttpApp({
        useCases: createUseCases({
          documentClient: clients.documentClient,
          tableName,
          clock,
          flags: new StaticFeatureFlagReader({ ENABLE_DYNAMIC_SURGE_PRICING: false }),
          pricing: PRICING,
        }),
        readinessCheck: createDynamoDbReadinessCheck(clients.client, tableName, 0),
        logger: createLogger({
          service: 'it',
          environment: 'test',
          version: 'test',
          destination: { write: () => undefined },
        }),
        requestTimeoutMs: 10_000,
      });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      if (server.listening) {
        server.close();
        await once(server, 'close');
      }
      await deleteTable(clients, tableName);
      clients.client.destroy();
    });

    it('readiness: la tabla existe y está ACTIVE', async () => {
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    });

    it('débito: saldo, débito y movimiento DEBIT escritos juntos, con auditoría', async () => {
      await fund('fleet_a', 5_000_000);
      expect((await putDebit('fleet_a', 1)).status).toBe(201);

      expect(await balanceOf('fleet_a')).toBe(5_000_000 - DEBIT_AMOUNT);
      expect(await raw(keys.debit(debitId(1)))).toMatchObject({
        status: 'DEBITED',
        amountMinor: DEBIT_AMOUNT,
        correlationId: CORRELATION_ID,
        idempotencyKey: debitId(1),
      });
      const debitEntry = (await ledgerOf('fleet_a')).find((item) => item.type === 'DEBIT');
      expect(debitEntry).toMatchObject({
        operationId: debitId(1),
        sagaId: sagaId(1),
        balanceAfterMinor: 5_000_000 - DEBIT_AMOUNT,
        correlationId: CORRELATION_ID,
      });
    });

    it('débito duplicado con la misma clave: 200 y no descuenta dos veces', async () => {
      const before = await balanceOf('fleet_a');
      expect((await putDebit('fleet_a', 1)).status).toBe(200);
      expect(await balanceOf('fleet_a')).toBe(before);
      expect((await ledgerOf('fleet_a')).filter((item) => item.type === 'DEBIT')).toHaveLength(1);
    });

    it('fondos insuficientes: 422, débito RECHAZADO auditable, saldo y libro mayor intactos', async () => {
      const before = await balanceOf('fleet_a');
      const response = await putDebit('fleet_a', 2, 100);
      expect(response.status).toBe(422);
      expect(await problemCode(response)).toBe('INSUFFICIENT_FUNDS');

      expect(await balanceOf('fleet_a')).toBe(before);
      expect(await raw(keys.debit(debitId(2)))).toMatchObject({
        status: 'REJECTED_INSUFFICIENT_FUNDS',
      });
      expect((await ledgerOf('fleet_a')).filter((item) => item.type === 'DEBIT')).toHaveLength(1);
    });

    it('concurrencia: 8 débitos simultáneos con saldo para 3 → 3 cobran, 5 rechazados, saldo ≥ 0', async () => {
      await fund('fleet_b', 3 * DEBIT_AMOUNT + 1_000);
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) => putDebit('fleet_b', 100 + i)),
      );
      const statuses = responses.map((response) => response.status);

      expect(statuses.filter((status) => status === 201)).toHaveLength(3);
      expect(statuses.filter((status) => status === 422)).toHaveLength(5);
      expect(await balanceOf('fleet_b')).toBe(1_000);
      expect((await ledgerOf('fleet_b')).filter((item) => item.type === 'DEBIT')).toHaveLength(3);
    });

    it('reembolso como operación propia: Refund + REFUNDED + saldo + movimiento REFUND', async () => {
      const before = await balanceOf('fleet_a');
      const response = await refund(1);
      const body = billingWalletV1.refundDebitResponseSchema.parse(await response.json());
      const refundId = `rfd_${uuid(1)}`;

      expect(body).toMatchObject({ outcome: 'REFUNDED', status: 'REFUNDED', refundId });
      expect(await balanceOf('fleet_a')).toBe(Number(before) + DEBIT_AMOUNT);
      expect(await raw(keys.refund(refundId))).toMatchObject({
        debitId: debitId(1),
        reason: 'CHARGER_HARDWARE_FAULT',
        amountMinor: DEBIT_AMOUNT,
        correlationId: CORRELATION_ID,
        idempotencyKey: refundId,
      });
      expect(await raw(keys.debit(debitId(1)))).toMatchObject({ status: 'REFUNDED', refundId });
    });

    it('reembolso duplicado y simultáneo: solo un REFUND, el saldo se restituye una vez', async () => {
      const before = await balanceOf('fleet_b');
      const outcomes = await Promise.all([refund(100), refund(100), refund(100)]);
      const bodies = await Promise.all(
        outcomes.map((response) => response.json() as Promise<{ outcome: string }>),
      );

      expect(bodies.map((body) => body.outcome).sort()).toEqual([
        'ALREADY_REFUNDED',
        'ALREADY_REFUNDED',
        'REFUNDED',
      ]);
      expect(await balanceOf('fleet_b')).toBe(Number(before) + DEBIT_AMOUNT);
      expect((await ledgerOf('fleet_b')).filter((item) => item.type === 'REFUND')).toHaveLength(1);
    });

    it('reembolso de un débito inexistente: tombstone; un cobro tardío → 409 DEBIT_VOIDED', async () => {
      const voided = await refund(900);
      expect(await voided.json()).toMatchObject({ outcome: 'VOIDED' });
      expect(await raw(keys.debit(debitId(900)))).toMatchObject({
        entity: 'DEBIT_TOMBSTONE',
        sagaId: sagaId(900),
        correlationId: CORRELATION_ID,
      });

      const before = await balanceOf('fleet_a');
      const late = await putDebit('fleet_a', 900);
      expect(late.status).toBe(409);
      expect(await problemCode(late)).toBe('DEBIT_VOIDED');
      expect(await balanceOf('fleet_a')).toBe(before);
    });

    it('otra SAGA no puede reembolsar el débito → 409 DEBIT_MISMATCH', async () => {
      const response = await refund(101, sagaId(999));
      expect(response.status).toBe(409);
      expect(await problemCode(response)).toBe('DEBIT_MISMATCH');
    });

    it('atomicidad: si falla cualquier condición de la transacción no se escribe nada', async () => {
      await fund('fleet_c', 5_000_000);
      const repository = new DynamoDbWalletRepository(clients.documentClient, tableName);
      const wallet = await repository.findWallet(FleetId.parse('fleet_c'));
      if (wallet === undefined) throw new Error('billetera');

      const charge = (n: number) => {
        const result = debitEstimatedCharge({
          debitId: DebitId.parse(debitId(n)),
          terms: {
            sagaId: SagaId.parse(sagaId(n)),
            fleetId: FleetId.parse('fleet_c'),
            energy: Energy.fromKwh(30),
            connectorPowerKw: 60,
          },
          wallet: wallet.value,
          existing: undefined,
          tombstone: undefined,
          pricing: new PricingPolicy(PRICING),
          surgePricingEnabled: false,
          audit: OperationAudit.of(CORRELATION_ID, debitId(n)),
          now: clock.now(),
        });
        if (result.kind !== 'DEBITED') throw new Error('se esperaba DEBITED');
        return result;
      };

      // 1) Versión de billetera obsoleta → nada escrito (ni débito ni movimiento).
      const stale = charge(300);
      await expect(
        repository.saveDebit({
          wallet: { value: stale.wallet, expectedVersion: wallet.version + 5 },
          debit: stale.debit,
          transaction: stale.transaction,
        }),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(await raw(keys.debit(debitId(300)))).toBeUndefined();

      // 2) Billetera correcta pero el débito ya existe → el saldo tampoco cambia.
      expect((await putDebit('fleet_c', 301)).status).toBe(201);
      const balanceAfterFirst = await balanceOf('fleet_c');
      const fresh = await repository.findWallet(FleetId.parse('fleet_c'));
      const duplicate = charge(301);
      await expect(
        repository.saveDebit({
          wallet: { value: duplicate.wallet, expectedVersion: fresh?.version ?? 0 },
          debit: duplicate.debit,
          transaction: duplicate.transaction,
        }),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(await balanceOf('fleet_c')).toBe(balanceAfterFirst);
      expect((await ledgerOf('fleet_c')).filter((item) => item.type === 'DEBIT')).toHaveLength(1);
    });

    it('historial paginado (más reciente primero) y trazabilidad por SAGA en GSI1', async () => {
      const page1 = billingWalletV1.listWalletTransactionsResponseSchema.parse(
        await (await fetch(`${url}/v1/wallets/fleet_a/transactions?limit=2`)).json(),
      );
      expect(page1.items.map((item) => item.type)).toEqual(['REFUND', 'DEBIT']);
      expect(page1.nextCursor).toBeDefined();
      const page2 = billingWalletV1.listWalletTransactionsResponseSchema.parse(
        await (
          await fetch(
            `${url}/v1/wallets/fleet_a/transactions?limit=2&cursor=${page1.nextCursor ?? ''}`,
          )
        ).json(),
      );
      expect(page2.items.map((item) => item.type)).toEqual(['TOP_UP']);

      const bad = await fetch(`${url}/v1/wallets/fleet_a/transactions?cursor=bm9wZQ`);
      expect(bad.status).toBe(400);

      const bySaga = await clients.documentClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: GSI1,
          KeyConditionExpression: 'GSI1PK = :saga',
          ExpressionAttributeValues: { ':saga': keys.sagaPartition(sagaId(1)) },
        }),
      );
      const sagaItems = (bySaga.Items ?? []) as Record<string, unknown>[];
      expect(sagaItems.map((item) => String(item.entity)).sort()).toEqual([
        'DEBIT',
        'LEDGER_ENTRY',
        'LEDGER_ENTRY',
        'REFUND',
      ]);
    });
  },
);
