# ADR-0019: Paquetes transversales `logger` (pino), `config` (zod) y `contracts`

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

CLAUDE.md permite paquetes compartidos pequeños y genéricos (logger, `correlation_id`, contratos), **sin lógica de dominio**. Se necesita:
- logging JSON con campos obligatorios y propagación de contexto ([ADR-0009](0009-propagacion-correlation-id-y-saga-id.md));
- validación de configuración al arrancar;
- convenciones HTTP comunes ([ADR-0004](0004-comunicacion-sincrona-http-contratos-openapi.md)).

## Decisión

- **`@aegisvolt/logger`** sobre **pino 10.4.0**:
  - expone un puerto `Logger` propio, sin tipos de pino, siguiendo Dependency Inversion;
  - salida de una línea JSON con `timestamp`, `level` (texto), `service`, `environment`, `version`, `correlation_id` y `message`;
  - `saga_id` cuando existe, mediante `AsyncLocalStorage` (`runWithLogContext`);
  - *redaction* de `authorization`, tokens, contraseñas y secretos.
- **`@aegisvolt/config`** sobre **zod 4.6.7**:
  - `baseEnvSchema` (`APP_ENV`, `SERVICE_VERSION`, `PORT`, `LOG_LEVEL`, `AWS_REGION`, `AWS_ENDPOINT_URL`);
  - `parseEnv(schema, env)` para extenderlo por servicio;
  - `loadBaseConfig` con el nombre del servicio fijado en código;
  - `ConfigValidationError` lista todas las variables inválidas **sin incluir sus valores**.
- **`@aegisvolt/contracts`:**
  - nombres de cabeceras (`x-correlation-id`, `x-saga-id`, `idempotency-key`);
  - tipo y *type guard* de `ProblemDetails` (RFC 9457);
  - un directorio `openapi/` para las especificaciones por servicio.
  - **No** contiene entidades ni reglas de negocio.
- La regla `domain-is-isolated` de dependency-cruiser impide que el dominio importe estos paquetes. Solo los usan las capas externas y `main.ts`.

## Alternativas

1. **Logger propio sobre `console`.** No requiere dependencias, pero habría que reimplementar niveles, *redaction*, serialización segura y escritura asíncrona.
2. **winston.** Más lento, con más configuración y sin ventaja aquí.
3. **Validación manual de `process.env`.** Es propensa a errores y no produce tipos; zod se usará también para validar entradas en los bordes.
4. **Un paquete `shared` único.** Tiende a acumular código de dominio compartido entre servicios, que es justo lo que CLAUDE.md prohíbe.

## Consecuencias

- **Positivas:**
  - Formato de log uniforme y verificado por pruebas (campos, contexto asíncrono, *redaction* y niveles).
  - Arranque *fail-fast* con un log `fatal` en JSON si la configuración es inválida.
  - El dominio permanece puro.
- **Negativas:**
  - Dos dependencias de producción (pino, zod) en cada servicio.
  - Un cambio en un paquete transversal afecta a todas las unidades: requiere versionado cuidadoso y pruebas.
