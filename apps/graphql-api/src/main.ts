// Composition root: carga configuración, crea adaptadores y arranca el proceso.
// Todavía no hay lógica de negocio; solo se exponen las probes de salud.
import { createLogger } from '@aegisvolt/logger';

import { SERVICE_NAME, loadServiceConfig } from './config.ts';
import { createHealthServer } from './interfaces/http/health-server.ts';

function bootstrap(): void {
  const config = loadServiceConfig(process.env);
  const logger = createLogger({
    service: config.serviceName,
    environment: config.appEnv,
    version: config.serviceVersion,
    level: config.logLevel,
  });

  const server = createHealthServer();
  server.listen(config.port, () => {
    logger.info('Servicio iniciado', { port: config.port });
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info('Apagado solicitado', { signal });
    server.close((error) => {
      if (error) {
        logger.error('Error al cerrar el servidor HTTP', { error: error.message });
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

try {
  bootstrap();
} catch (error) {
  createLogger({
    service: SERVICE_NAME,
    environment: process.env.APP_ENV ?? 'unknown',
    version: process.env.SERVICE_VERSION ?? 'unknown',
  }).fatal('Arranque fallido', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
