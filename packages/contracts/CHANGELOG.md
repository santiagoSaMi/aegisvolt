# Changelog de @aegisvolt/contracts

Formato: una sección por contrato y versión. Política de versionado: [docs/contracts/README.md](../../docs/contracts/README.md#versionado).

## 2026-11-13 — billing-wallet 1.1.0

Cambios al implementar billing-wallet-service (ADR-0022). Todos compatibles (*minor*):

- **Común:** prefijo `rfd` y `refundIdSchema`.
- **Nuevo:**
  - `PUT /v1/wallets/{fleetId}` (`openWalletRequestSchema`);
  - `GET /v1/wallets/{fleetId}/funds-check` (`fundsCheckQuerySchema`, `fundsCheckViewSchema`);
  - `POST /v1/debits` con `idempotency-key` (`createDebitRequestSchema`);
  - `GET /v1/debits/{debitId}` documentado;
  - `paths.fundsCheck` y `paths.debits`;
  - error `DEBIT_MISMATCH`.
- **Campos añadidos en respuestas:**
  - `walletTransactionViewSchema`: `operationId`, `refundId`, `correlationId`, `idempotencyKey` (auditoría de cada movimiento);
  - `debitViewSchema.refundId`;
  - `refundDebitResponseSchema.refundId`.

## 2026-11-13 — station-reservation 1.1.0

Cambios al implementar station-reservation-service (ADR-0021):

- **Nuevo:**
  - `PUT /v1/stations/{stationId}` (`registerStationRequestSchema`);
  - `GET /v1/connectors/available` (`listAvailableConnectorsQuerySchema`, `availableConnectorViewSchema`);
  - `POST /v1/reservations` con `idempotency-key` (`createReservationRequestSchema`);
  - `paths.availableConnectors` y `paths.reservations`;
  - errores `RESERVATION_MISMATCH` y `STATION_ALREADY_EXISTS`.
- **Corrección *pre-release*** (cambios que la política consideraría mayores, aceptados porque la v1 aún no tiene consumidores implementados):
  - estado de conector `OCCUPIED` (carga en curso);
  - `city` obligatoria en `GET /v1/stations` (consulta por índice, sin Scan).

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
