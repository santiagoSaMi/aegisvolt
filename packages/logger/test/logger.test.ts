import { describe, expect, it } from 'vitest';

import {
  createLogger,
  logOperation,
  runWithLogContext,
  setLogOperation,
  toLoggedError,
  type LogDestination,
} from '../src/index.ts';

function memoryDestination(): {
  destination: LogDestination;
  lines: () => Record<string, unknown>[];
} {
  const buffer: string[] = [];
  return {
    destination: { write: (line: string) => buffer.push(line) },
    lines: () => buffer.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const baseOptions = { service: 'example-service', environment: 'test', version: 'sha-abc123' };

describe('createLogger', () => {
  it('emite JSON con los campos obligatorios', () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, destination });

    logger.info('Servicio iniciado', { port: 4100 });

    const [entry] = lines();
    expect(entry).toMatchObject({
      level: 'info',
      service_name: 'example-service',
      environment: 'test',
      version: 'sha-abc123',
      correlation_id: null,
      operation: null,
      message: 'Servicio iniciado',
      port: 4100,
    });
    expect(typeof entry?.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(String(entry?.timestamp)))).toBe(false);
  });

  it('propaga correlation_id y saga_id a través de operaciones asíncronas', async () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, destination });

    await runWithLogContext({ correlationId: 'c-123', sagaId: 's-456' }, async () => {
      await Promise.resolve();
      logger.child({ component: 'saga' }).warn('Compensación iniciada');
    });
    logger.info('Fuera de contexto');

    const [inside, outside] = lines();
    expect(inside).toMatchObject({ correlation_id: 'c-123', saga_id: 's-456', component: 'saga' });
    expect(outside).toMatchObject({ correlation_id: null });
    expect(outside).not.toHaveProperty('saga_id');
  });

  it('oculta valores sensibles', () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, destination });

    logger.info('Petición recibida', {
      headers: { authorization: 'Bearer eyJ-secreto' },
      user: { password: 'p4ss' },
    });

    const serialized = JSON.stringify(lines()[0]);
    expect(serialized).not.toContain('eyJ-secreto');
    expect(serialized).not.toContain('p4ss');
    expect(serialized).toContain('[REDACTED]');
  });

  it('respeta el nivel configurado', () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, level: 'warn', destination });

    logger.info('descartado');
    logger.error('registrado');

    expect(lines().map((line) => line.message)).toEqual(['registrado']);
  });

  it('incluye la operación fijada por un middleware y permite sobrescribirla por línea', async () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, destination });

    await runWithLogContext({ correlationId: 'c-1' }, async () => {
      logOperation('CreateDebit')({}, {}, () => undefined);
      await Promise.resolve();
      logger.info('Débito creado');
      logger.info('Arranque', { operation: 'Startup' });
    });
    setLogOperation('sin-contexto'); // no falla ni contamina otros logs
    logger.info('Fuera');

    expect(lines().map((line) => line.operation)).toEqual(['CreateDebit', 'Startup', null]);
    expect(lines()[0]).toMatchObject({ correlation_id: 'c-1' });
  });

  it('la operación de una petición no se filtra a otra concurrente', async () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, destination });
    const request = (id: string, operation: string) =>
      runWithLogContext({ correlationId: id }, async () => {
        setLogOperation(operation);
        await new Promise((resolve) => setTimeout(resolve, 5));
        logger.info('fin');
      });

    await Promise.all([request('a', 'OpA'), request('b', 'OpB')]);

    expect(
      lines()
        .map((line) => `${String(line.correlation_id)}:${String(line.operation)}`)
        .sort(),
    ).toEqual(['a:OpA', 'b:OpB']);
  });

  it('registra errores con forma tipada: los de dominio sin stack, los inesperados con stack', () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, destination });
    class InsufficientFundsError extends Error {
      readonly code = 'INSUFFICIENT_FUNDS';
      override readonly name = 'InsufficientFundsError';
    }

    logger.warn('Cobro rechazado', { error: new InsufficientFundsError('Saldo insuficiente') });
    logger.error('Fallo', { error: new TypeError('x is undefined', { cause: new Error('raíz') }) });
    logger.error('Texto', { error: 'algo falló' });

    const [domain, unexpected, text] = lines();
    expect(domain?.error).toEqual({
      type: 'InsufficientFundsError',
      code: 'INSUFFICIENT_FUNDS',
      message: 'Saldo insuficiente',
    });
    expect(unexpected?.error).toMatchObject({
      type: 'TypeError',
      message: 'x is undefined',
      cause: { message: 'raíz' },
    });
    expect((unexpected?.error as { stack?: string }).stack).toContain('TypeError');
    expect(text?.error).toEqual({ type: 'NonError', message: 'algo falló' });
  });

  it('toLoggedError acota la profundidad de causas y la longitud del mensaje', () => {
    const long = toLoggedError(new Error('x'.repeat(2_000)));
    expect(long.message.length).toBeLessThanOrEqual(501);
    let error = new Error('nivel 0');
    for (let i = 1; i <= 6; i++) error = new Error(`nivel ${String(i)}`, { cause: error });
    let depth = 0;
    for (let current = toLoggedError(error).cause; current !== undefined; current = current.cause)
      depth++;
    expect(depth).toBe(3);
  });

  it('oculta credenciales y datos personales en primer y segundo nivel', () => {
    const { destination, lines } = memoryDestination();
    const logger = createLogger({ ...baseOptions, destination });

    logger.info('Datos', {
      idToken: 'eyJ.id',
      credentials: { accessKeyId: 'AKIAFAKE' },
      user: { email: 'ana@example.com', phone: '+57 300' },
      headers: { cookie: 'sid=1', 'x-api-key': 'k-1', 'set-cookie': 'a=b' },
      AuthParameters: { USERNAME: 'ana', PASSWORD: 'p' },
    });

    const serialized = JSON.stringify(lines()[0]);
    for (const secret of [
      'eyJ.id',
      'AKIAFAKE',
      'ana@example.com',
      '+57 300',
      'sid=1',
      'k-1',
      'a=b',
      'USERNAME',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
