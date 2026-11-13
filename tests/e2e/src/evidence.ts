// Evidencia de DynamoDB: lee (solo lectura, como Prefect) los ítems que dejó
// cada escenario en las tablas de los cuatro servicios y los guarda en JSON.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { EVIDENCE_DIR, type Stack } from './stack.ts';

type Item = Record<string, unknown>;

export interface SagaEvidence {
  readonly saga: Item | undefined;
  readonly events: readonly Item[];
  readonly reservation: Item | undefined;
  readonly connector: Item | undefined;
  readonly debit: Item | undefined;
  readonly refund: Item | undefined;
  readonly wallet: Item | undefined;
  readonly ledger: readonly Item[];
  readonly session: Item | undefined;
}

async function get(stack: Stack, TableName: string, PK: string, SK = 'META') {
  const { Item } = await stack.db.send(
    new GetCommand({ TableName, Key: { PK, SK }, ConsistentRead: true }),
  );
  return Item;
}

async function query(stack: Stack, TableName: string, PK: string, prefix: string) {
  const { Items } = await stack.db.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix },
      ConsistentRead: true,
    }),
  );
  return Items ?? [];
}

/** Todo lo que dejó una SAGA en las cinco tablas. */
export async function collect(stack: Stack, sagaId: string): Promise<SagaEvidence> {
  const { tables } = stack;
  const saga = await get(stack, tables.sagas, `SAGA#${sagaId}`);
  const events = await query(stack, tables.sagas, `SAGA#${sagaId}`, 'EVT#');
  const reservationId = String(saga?.reservationId);
  const debitId = String(saga?.debitId);
  const sessionId = String(saga?.sessionId);
  const fleetId = String(saga?.fleetId);
  const debit = await get(stack, tables.billing, `DEBIT#${debitId}`);
  const refundId = typeof debit?.refundId === 'string' ? debit.refundId : undefined;
  const ledger = (await query(stack, tables.billing, `WALLET#${fleetId}`, 'TX#')).filter(
    (entry) => entry.debitId === debitId,
  );
  return {
    saga,
    events,
    reservation: await get(stack, tables.reservations, `RES#${reservationId}`),
    connector: await get(
      stack,
      tables.reservations,
      `STATION#${String(saga?.stationId)}`,
      `CONN#${String(saga?.connectorId)}`,
    ),
    debit,
    refund:
      refundId === undefined ? undefined : await get(stack, tables.billing, `REFUND#${refundId}`),
    wallet: await get(stack, tables.billing, `WALLET#${fleetId}`),
    ledger,
    session: await get(stack, tables.dispatch, `SESSION#${sessionId}`),
  };
}

/** Resumen legible (lo que se muestra en la sustentación) y volcado completo. */
export function save(name: string, evidence: SagaEvidence): void {
  const summary = {
    saga: pick(evidence.saga, [
      'sagaId',
      'status',
      'failureReason',
      'failedStep',
      'compensationPlan',
      'compensationFailure',
      'correlationId',
      'version',
    ]),
    steps: evidence.saga?.steps,
    events: evidence.events.map((e) =>
      [e.sequence, e.type, e.step ?? '', e.status, e.errorCode ?? ''].join(' | '),
    ),
    reservation: pick(evidence.reservation, ['reservationId', 'status', 'sagaId']),
    connector: pick(evidence.connector, ['connectorId', 'status', 'holdReservationId']),
    debit: pick(evidence.debit, ['debitId', 'status', 'amountMinor', 'refundId', 'sagaId']),
    refund: pick(evidence.refund, ['refundId', 'debitId', 'amountMinor', 'reason']),
    wallet: pick(evidence.wallet, ['fleetId', 'balanceMinor', 'version']),
    ledger: evidence.ledger.map((e) =>
      pick(e, ['type', 'amountMinor', 'balanceAfterMinor', 'correlationId']),
    ),
    session: pick(evidence.session, ['sessionId', 'status', 'faultCode', 'faultSimulated']),
  };
  writeFileSync(
    join(EVIDENCE_DIR, `${name}.json`),
    `${JSON.stringify({ summary, raw: evidence }, null, 2)}\n`,
  );
}

function pick(item: Item | undefined, fields: readonly string[]): Item | undefined {
  if (item === undefined) {
    return undefined;
  }
  return Object.fromEntries(fields.filter((f) => f in item).map((f) => [f, item[f]]));
}
