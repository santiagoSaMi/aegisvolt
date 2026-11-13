import { describe, expect, it } from 'vitest';

import { createLogger, runWithLogContext, type LogDestination } from '../src/index.ts';

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
      service: 'example-service',
      environment: 'test',
      version: 'sha-abc123',
      correlation_id: null,
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
});
