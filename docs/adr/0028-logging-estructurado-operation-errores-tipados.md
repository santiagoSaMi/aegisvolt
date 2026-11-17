# ADR-0028: Logging estructurado: esquema de campos, `operation`, errores tipados y redacción

- **Estado:** Aceptado
- **Fecha:** 2026-11-14
- **Complementa:** [ADR-0009](0009-propagacion-correlation-id-y-saga-id.md) (propagación de `correlation_id` y `saga_id`), [ADR-0014](0014-observabilidad-cloudwatch-fluent-bit-prefect.md) (CloudWatch y Prefect) y [ADR-0019](0019-paquetes-transversales-logger-config-contracts.md) (paquete `@aegisvolt/logger`)

## Contexto

La rúbrica (§5, punto 4; §6.4) exige rastrear en CloudWatch, por ambiente y `correlation_id`, una transacción SAGA fallida. Los cuatro servicios y el graphql-api ya escribían una línea JSON por evento con `@aegisvolt/logger` (pino) y propagaban `correlation_id` y `saga_id` mediante AsyncLocalStorage y cabeceras HTTP. Faltaba lo siguiente:

- **Nombre del servicio:** el campo se llamaba `service`, y el requisito de esta fase pide `service_name`.
- **Operación de negocio:** ninguna línea decía qué operación se ejecutaba (no había `operation`).
- **Errores:** se registraban como texto (`"Name: message"`), con el stack en un campo aparte o sin él. No había forma estable de filtrar por tipo o código.
- **Rechazos de negocio** (saldo insuficiente, conector no disponible): no se registraban. Solo aparecían como `http_status` 4xx.
- **Redacción:** cubría solo contraseñas, tokens y `authorization`.

## Decisión

### Esquema de cada línea

| Campo | Origen | Siempre |
| --- | --- | --- |
| `timestamp` | ISO-8601 UTC | sí |
| `level` | `fatal`, `error`, `warn`, `info`, `debug` o `trace` | sí |
| `environment` | `APP_ENV` del despliegue | sí |
| `service_name` | p. ej. `billing-wallet-service` | sí |
| `version` | imagen o commit (para el canary) | sí |
| `correlation_id` | contexto de la petición o de la SAGA (`null` fuera de contexto: arranque y apagado) | sí |
| `saga_id` | contexto (cabecera `x-saga-id` o la propia SAGA) | cuando aplica |
| `operation` | operación de negocio (ver abajo; `null` si no hay ninguna) | sí |
| `message` | texto legible | sí |
| `error` | `{ type, code?, message, stack?, cause? }` | cuando hay error |
| `event`, `http_status`, `duration_ms`, … | datos propios del evento | según el evento |

### `operation`

- **Servicios.** Cada ruta se nombra con el caso de uso que invoca, mediante el middleware `logOperation('DebitWallet')` de `@aegisvolt/logger`. Es compatible con Express sin depender de él.
  - El middleware fija la operación en el contexto de la petición. Todas las líneas de esa petición la incluyen: dominio, adaptadores, el log por petición y los rechazos.
  - Si ninguna ruta la nombró (por ejemplo, un 404 de ruta), la línea `http_request` usa `MÉTODO /ruta`.
- **graphql-api.** Un plugin de Apollo fija `operation` cuando Apollo resuelve la operación: `<tipo>.<nombre>`, por ejemplo `mutation.ReserveAndActivateCharging`. Si la operación es anónima, usa el primer campo raíz (`query.stations`). El nombre lo envía el cliente: ya es un `Name` válido de GraphQL y se acota a 64 caracteres.
- **Procesos sin petición.**
  - `Startup` y `Shutdown`.
  - `RecoverSagas` y `RetryCompensation` (worker y script de recuperación).
  - Los eventos de la SAGA usan `ReserveAndActivateCharging`, también cuando la retoma la recuperación.
- **Implementación.**
  - El almacén del contexto es mutable solo en `operation` (`setLogOperation`), porque la operación se conoce después de crear el contexto: el router y Apollo la resuelven más tarde.
  - Cada petición tiene su propio almacén, así que no hay fugas entre peticiones concurrentes (hay prueba).

### Errores tipados

- El logger tiene un serializer para el campo `error`. Los llamadores pasan el error tal cual (`{ error }`) y se registra con forma estable:
  - `type`: clase del error;
  - `code`: si el error tiene un `code` de dominio, aplicación, AWS SDK o red;
  - `message`: acotado a 500 caracteres;
  - `cause`: hasta 3 niveles.
- Los errores **con `code`** son esperados y van sin stack. Los **inesperados** conservan el `stack`. El stack queda solo en el log, nunca en las respuestas.
- Los **rechazos de negocio** (`DomainError` o `ApplicationError` con respuesta 4xx) se registran en `warn` como `Operación rechazada`, con el error tipado, `http_status` y `problem_code`. Los 5xx siguen en `error`.
- **Fallos que no son excepciones:**
  - un paso fallido de la SAGA → `{ type: 'SagaStepFailure', code: <código del servicio> }`;
  - una compensación fallida → `SagaCompensationFailure`;
  - la falla simulada del cargador → `ChargerHardwareFault` con `E-HW-001`.

### Propagación del `correlation_id`

No cambia respecto de ADR-0009:

- Cada borde HTTP acepta `x-correlation-id` si es un UUID y, si no, genera uno. Lo devuelve en la respuesta y lo pone en el contexto.
- Las llamadas salientes lo reenvían: graphql-api → servicios, y orquestador → participantes, con `x-saga-id`.
- Los eventos de la SAGA usan el `correlation_id` **original** de la SAGA.
- El E2E verifica que un solo `correlation_id` recorre los cinco procesos.

### Datos que no se registran

- **Redacción** en el primer y segundo nivel de los campos:
  - secretos y credenciales: `password`, `token`, `idToken`, `accessToken`, `refreshToken`, `secret`, `clientSecret`, `secretAccessKey`, `accessKeyId`, `sessionToken`, `credentials`, `AuthParameters`;
  - cabeceras sensibles: `authorization`, `cookie`, `set-cookie`, `x-api-key`, `apiKey`;
  - datos personales: `email`, `phone`, `phoneNumber`.
- **Por diseño no se registran:**
  - cabeceras, *query string* ni cuerpos de petición (la línea `http_request` solo lleva el método y la ruta);
  - el valor de un token rechazado (solo el motivo);
  - la identidad del usuario. El `sub` de Cognito queda en la auditoría de flags en DynamoDB, no en los logs.
- La redacción es una red de seguridad, no un permiso: la regla es no pasar esos datos al logger.

## Alternativas

1. **Nombrar la operación con la ruta HTTP** (`PUT /v1/debits/:debitId`). Es automático, pero mezcla transporte con negocio: dos rutas del mismo caso de uso (`PUT` y `POST` de débitos) tendrían nombres distintos y GraphQL no tendría equivalente. Se usa solo como respaldo.
2. **`logger.child({ operation })` en cada caso de uso.** Exige pasar el logger hijo por todas las capas. Además, pino duplica la clave si también la añade el `mixin` del contexto.
3. **OpenTelemetry (trazas y spans).** Es el estándar para trazas distribuidas, pero añade un SDK, un *collector* y un *backend* de trazas que Floci no emula. La especificación pide trazabilidad en CloudWatch Logs por `correlation_id`, y este esquema la cubre. Queda como mejora.
4. **Mantener `service` además de `service_name`.** Duplica datos en cada línea. Se usa solo `service_name`. No había consultas ni filtros que dependieran de `service` (se revisaron docs, infra y pruebas).

## Consecuencias

- **Positivas:**
  - Una consulta de CloudWatch Logs Insights por `correlation_id` en `/aegisvolt/<env>/*` devuelve el recorrido completo: qué operación ejecutó cada servicio, qué falló (`error.type` y `error.code`) y qué se compensó.
  - Las líneas tienen el mismo esquema en los cinco procesos, lo que facilita los *metric filters* y Prefect.
- **Negativas:**
  - Cada ruta nueva debe nombrarse con `logOperation`. Si se olvida, el respaldo `MÉTODO /ruta` sigue siendo trazable.
  - El esquema contradice CLAUDE.md, que nombra el campo `service`. Hay que actualizar CLAUDE.md.
