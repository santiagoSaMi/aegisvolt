import type { CallContext, CallOutcome, SagaParticipants } from '../../src/application/index.ts';

export type Operation =
  | 'getConnectorPower'
  | 'holdReservation'
  | 'confirmReservation'
  | 'releaseReservation'
  | 'debit'
  | 'refundDebit'
  | 'activateSession'
  | 'getSession'
  | 'abortSession';

export interface RecordedCall {
  readonly operation: Operation;
  readonly ctx: CallContext;
  /** Argumentos de la llamada, sin el contexto. */
  readonly args: readonly unknown[];
}

type Outcome = CallOutcome<Record<string, unknown>>;

/** Respuestas por defecto: el camino feliz con resultados verificables. */
const DEFAULTS: Record<Operation, Outcome> = {
  getConnectorPower: { kind: 'OK', value: { maxPowerKw: 60 } },
  holdReservation: { kind: 'OK', value: { status: 'HELD' } },
  confirmReservation: { kind: 'OK', value: { status: 'CONFIRMED' } },
  releaseReservation: { kind: 'OK', value: { status: 'RELEASED', outcome: 'RELEASED' } },
  debit: { kind: 'OK', value: { status: 'DEBITED', amountMinor: 3_000_000 } },
  refundDebit: { kind: 'OK', value: { status: 'REFUNDED', outcome: 'REFUNDED' } },
  activateSession: { kind: 'OK', value: { status: 'ACTIVE' } },
  getSession: { kind: 'REJECTED', code: 'SESSION_NOT_FOUND' },
  abortSession: { kind: 'OK', value: { status: 'ABORTED', outcome: 'ABORTED' } },
};

/**
 * Participantes programables: cada operación responde con una cola de
 * resultados (luego, con su valor por defecto) y registra la llamada con su
 * contexto (correlation_id, saga_id, clave idempotente).
 */
export class FakeParticipants {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<Operation, Outcome[]>();
  private readonly gates = new Map<Operation, Promise<void>>();
  /** Se ejecuta en cada llamada (p. ej. para simular un reinicio a mitad de paso). */
  onCall: ((operation: Operation) => void) | undefined;

  /** Programa los próximos resultados de una operación. */
  respond(operation: Operation, ...outcomes: Outcome[]): this {
    this.queues.set(operation, [...(this.queues.get(operation) ?? []), ...outcomes]);
    return this;
  }

  /** La operación falla de forma transitoria `times` veces. */
  failTransiently(operation: Operation, times: number, code = 'HTTP_503'): this {
    return this.respond(
      operation,
      ...Array.from({ length: times }, (): Outcome => ({ kind: 'TRANSIENT', code })),
    );
  }

  /** La próxima llamada a `operation` espera hasta invocar la función devuelta. */
  block(operation: Operation): () => void {
    let release: () => void = () => undefined;
    this.gates.set(
      operation,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      release();
    };
  }

  callsTo(operation: Operation): RecordedCall[] {
    return this.calls.filter((call) => call.operation === operation);
  }

  get operations(): Operation[] {
    return this.calls.map((call) => call.operation);
  }

  build(): SagaParticipants {
    const handle =
      (operation: Operation) =>
      (args: unknown, ...rest: unknown[]) => {
        const ctx = rest.at(-1) as CallContext;
        this.calls.push({ operation, ctx, args: [args, ...rest.slice(0, -1)] });
        this.onCall?.(operation);
        const next = this.queues.get(operation)?.shift() ?? DEFAULTS[operation];
        const gate = this.gates.get(operation);
        this.gates.delete(operation);
        return gate === undefined ? Promise.resolve(next) : gate.then(() => next);
      };
    return {
      station: {
        getConnectorPower: handle('getConnectorPower') as never,
        holdReservation: handle('holdReservation') as never,
        confirmReservation: handle('confirmReservation') as never,
        releaseReservation: handle('releaseReservation') as never,
      },
      billing: {
        debit: handle('debit') as never,
        refundDebit: handle('refundDebit') as never,
      },
      dispatch: {
        activateSession: handle('activateSession') as never,
        getSession: handle('getSession') as never,
        abortSession: handle('abortSession') as never,
      },
    };
  }
}
