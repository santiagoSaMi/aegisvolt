# Changelog de @aegisvolt/contracts

Formato: una sección por contrato y versión. Política de versionado: [docs/contracts/README.md](../../docs/contracts/README.md#versionado).

## 2026-11-13

### Común
- Identificadores con prefijo (`st_`, `cn_`, `fleet_`, `saga_`, `res_`, `dbt_`, `tup_`, `wtx_`, `ses_`), `correlationIdSchema` e `idempotencyKeySchema` (UUID).
- Primitivas: `isoDateTimeSchema` (UTC), `energyKwhSchema`, `powerKwSchema`, `moneySchema` (unidades menores), `citySchema`, `paginationQuerySchema` y `COMPENSATION_REASONS`.
- Cabeceras: `correlationHeadersSchema`, `sagaCommandHeadersSchema` e `idempotentCommandHeadersSchema`.
- `problemDetailsSchema` (RFC 9457 + `code`, `correlationId`, `errors[]`), `COMMON_ERROR_CODES` y `problemSchemaFor`.
- **Cambio:** `ProblemDetails.correlationId` ahora debe ser un UUID. `isProblemDetails` usa el esquema Zod.

### station-reservation 1.0.0
- Versión inicial: estaciones, hold, confirmación y liberación de reservas.

### billing-wallet 1.0.0
- Versión inicial: billetera, movimientos, débito, reembolso y recarga.

### energy-dispatch 1.0.0
- Versión inicial: activación, aborto, consulta de sesión y telemetría.

### saga-orchestrator 1.0.0
- Versión inicial: inicio de la SAGA, consulta, listado e historial de eventos.

### feature-flags 1.0.0
- Versión inicial: claves de las tres flags, servicio evaluador y estado leído del almacén.
