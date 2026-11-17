import { InvalidValueError } from './domain-error.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Trazabilidad de una operación financiera: qué petición la originó
 * (`correlationId`) y con qué clave idempotente se pidió. Se guarda en cada
 * débito, reembolso, recarga y movimiento del libro mayor (requisito de auditoría).
 */
export class OperationAudit {
  readonly correlationId: string;
  readonly idempotencyKey: string;

  private constructor(correlationId: string, idempotencyKey: string) {
    this.correlationId = correlationId;
    this.idempotencyKey = idempotencyKey;
  }

  static of(correlationId: string, idempotencyKey: string): OperationAudit {
    if (!UUID.test(correlationId)) {
      throw new InvalidValueError('correlationId', 'debe ser un UUID en minúsculas');
    }
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new InvalidValueError('idempotencyKey', 'debe tener 1–128 caracteres [A-Za-z0-9_-]');
    }
    return new OperationAudit(correlationId, idempotencyKey);
  }
}
