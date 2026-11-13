# Contratos de integración

Contratos públicos entre las unidades desplegables de AegisVolt. La **fuente de verdad** son los esquemas Zod de [`packages/contracts`](../../packages/contracts/src/); este documento los resume y fija las reglas de versionado ([ADR-0020](../adr/0020-modelos-de-dominio-y-contratos-zod.md)).

| Contrato | Módulo | Versión | Proveedor | Consumidores |
| --- | --- | --- | --- | --- |
| station-reservation | `stationReservationV1` | 1.1.0 | station-reservation-service | saga-orchestrator (comandos), graphql-api (lecturas) |
| billing-wallet | `billingWalletV1` | 1.0.0 | billing-wallet-service | saga-orchestrator (débito y reembolso), graphql-api (billetera y recargas) |
| energy-dispatch | `energyDispatchV1` | 1.0.0 | energy-dispatch-service | saga-orchestrator (activación y aborto), graphql-api (sesiones y telemetría) |
| saga-orchestrator | `sagaOrchestratorV1` | 1.0.0 | saga-orchestrator-service | graphql-api |
| feature-flags (datos, no HTTP) | `featureFlagsV1` | 1.0.0 | graphql-api (único escritor) | los tres servicios (lectura) |

Historial de cambios: [`packages/contracts/CHANGELOG.md`](../../packages/contracts/CHANGELOG.md).

## Qué va en `packages/contracts` y qué no

| Sí | No |
| --- | --- |
| Formato de peticiones y respuestas (DTOs) | Entidades, agregados y reglas de negocio |
| Cabeceras, identificadores y primitivas de red | Value Objects internos (`Money`, `Energy`, `PowerKw`…) |
| Catálogo de códigos de error y su status HTTP | Errores de dominio (clases) |
| Vocabulario público (estados, motivos) | Máquinas de estado e invariantes |

Cada servicio tiene su propio modelo en `src/domain/`. Las pruebas `test/domain/contract-alignment.test.ts` de cada servicio verifican que su vocabulario interno y sus códigos de error coinciden con el contrato publicado.

## Convenciones comunes

**Rutas.** Prefijo de versión mayor: `/v1/...`. Cada módulo exporta `API` (`name`, `version`, `basePath`) y `paths` (constructores de rutas con `encodeURIComponent`).

**Formato.** JSON en camelCase.
- **Fechas:** ISO-8601 en UTC con `Z`.
- **Dinero:** `{ amountMinor: entero ≥ 0, currency: ISO-4217 }`. Los importes van en unidades menores, nunca en coma flotante.
- **Energía:** `energyKwh` > 0, ≤ 500 y con 3 decimales como máximo (1 Wh).

**Identificadores explícitos y estables** (`<prefijo>_<valor>`, el valor en minúsculas, dígitos y guiones, 1–63 caracteres):

| Recurso | Prefijo | Origen | Ejemplo |
| --- | --- | --- | --- |
| Estación | `st` | catálogo | `st_bog-norte-01` |
| Conector | `cn` | catálogo | `cn_01` |
| Flota | `fleet` | catálogo (claim `custom:fleet_id`) | `fleet_001` |
| SAGA | `saga` | orquestador (UUID v4) | `saga_3f2c1e5a-1b2c-4d3e-8f90-123456789abc` |
| Reserva | `res` | orquestador, pre-generado | `res_<uuid>` |
| Débito | `dbt` | orquestador, pre-generado | `dbt_<uuid>` |
| Sesión de carga | `ses` | orquestador, pre-generado | `ses_<uuid>` |
| Recarga | `tup` | graphql-api | `tup_<uuid>` |
| Movimiento de billetera | `wtx` | billing-wallet | `wtx_<uuid>` |

`correlation_id` e `idempotency-key` son UUID sin prefijo.

**Cabeceras** (nombres en minúsculas):

| Cabecera | Dónde | Esquema |
| --- | --- | --- |
| `x-correlation-id` | todas las llamadas internas | `correlationHeadersSchema` |
| `x-saga-id` | comandos de la SAGA (orquestador → servicios) | `sagaCommandHeadersSchema` |
| `idempotency-key` | `POST /v1/sagas` (una por acción del usuario) | `idempotentCommandHeadersSchema` |

**Idempotencia** ([ADR-0005](../adr/0005-idempotencia-ids-pregenerados-y-tombstones.md)):
- **Comandos de la SAGA:** son `PUT` sobre IDs pre-generados.
  - `201` si se creó el recurso; `200` si es una repetición con el mismo cuerpo (se devuelve el resultado original).
  - `409 IDEMPOTENCY_CONFLICT` si el ID ya existe con otro cuerpo.
- **Compensaciones:** `release`, `refund` y `abort` son idempotentes y devuelven un `outcome` explícito.
  - Si el recurso no existía, responden `VOIDED` y dejan un tombstone; un `PUT` posterior con ese ID responde `409 *_CANCELLED/VOIDED/ABORTED`.

**Errores.** RFC 9457 (`application/problem+json`): `type`, `title`, `status`, `code`, y opcionalmente `detail`, `instance`, `correlationId` y `errors[]` (en `VALIDATION_ERROR`). Cada API publica `ERROR_CODES` (código → status) y `problemSchema`, que restringe `code` a su catálogo.
- **Errores comunes:** `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `ROUTE_NOT_FOUND` 404, `INTERNAL_ERROR` 500, `SERVICE_UNAVAILABLE` 503.
- **Reintentos:** solo `5xx`, `429` y fallos de red. Los códigos de negocio (`403`/`404`/`409`/`422`) son definitivos.

**Validación.**
- **Peticiones:** el proveedor las valida con esquemas estrictos (`z.strictObject`), que rechazan campos desconocidos.
- **Respuestas:** el consumidor las valida en modo *tolerant reader* (`z.object`), que ignora campos nuevos. Así una adición en el proveedor no rompe a los consumidores.

## station-reservation v1

| Operación | Petición | Respuesta | Errores de negocio |
| --- | --- | --- | --- |
Versión 1.1.0, implementada en [station-reservation-service](../../services/station-reservation/README.md).

| Operación | Petición | Respuesta | Errores de negocio |
| --- | --- | --- | --- |
| `PUT /v1/stations/{stationId}` (alta de catálogo) | `registerStationRequestSchema` (1–20 conectores sin ids repetidos) | `201` / `200` (ya existía idéntica) `stationViewSchema` | `409 STATION_ALREADY_EXISTS` |
| `GET /v1/stations?city=` (city obligatoria) | `listStationsQuerySchema` | `listStationsResponseSchema` (`items[]` con conectores y `availableForReservation`) | — |
| `GET /v1/stations/{stationId}` | — | `stationViewSchema` | `404 STATION_NOT_FOUND` |
| `GET /v1/connectors/available?city=` o `?stationId=` | `listAvailableConnectorsQuerySchema` (exactamente uno) | `listAvailableConnectorsResponseSchema` | `404 STATION_NOT_FOUND` |
| `PUT /v1/reservations/{reservationId}` (SAGA paso 1; `x-saga-id` = `body.sagaId`) | `holdReservationRequestSchema` `{sagaId, fleetId, stationId, connectorId, fastChargeBoost}` | `201`/`200` `reservationViewSchema` (HELD, `holdExpiresAt`) | `409 CONNECTOR_UNAVAILABLE`, `409 ULTRA_FAST_REQUIRES_BOOST`, `403 FAST_CHARGE_BOOST_DISABLED`, `409 RESERVATION_CANCELLED`, `409 IDEMPOTENCY_CONFLICT`, `404 CONNECTOR_NOT_FOUND` |
| `POST /v1/reservations` + `idempotency-key` | `createReservationRequestSchema` (mismo cuerpo) | `201`/`200` `reservationViewSchema`, `location: /v1/reservations/res_<clave>` | iguales que el `PUT` |
| `GET /v1/reservations/{id}` | — | `reservationViewSchema` (estado efectivo: un HELD vencido se informa EXPIRED) | `404 RESERVATION_NOT_FOUND` |
| `POST /v1/reservations/{id}/confirm` (fin de la SAGA) | `{}` | `reservationViewSchema` (CONFIRMED; conector → OCCUPIED) | `409 RESERVATION_NOT_HELD`, `409 RESERVATION_HOLD_EXPIRED`, `409 RESERVATION_MISMATCH`, `409 RESERVATION_CANCELLED`, `404 RESERVATION_NOT_FOUND` |
| `POST /v1/reservations/{id}/release` (compensación) | `{reason}` | `{reservationId, status, outcome: RELEASED \| ALREADY_RELEASED \| VOIDED}` | `409 RESERVATION_MISMATCH` (`x-saga-id` no es la dueña) |

Estados (efectivos en el momento de la consulta):
- **Conector:** `AVAILABLE | RESERVED | OCCUPIED | OUT_OF_SERVICE`.
- **Reserva:** `HELD | CONFIRMED | RELEASED | EXPIRED | VOIDED`.

Si los conflictos de concurrencia persisten tras 3 intentos, la respuesta es `503 SERVICE_UNAVAILABLE`, reintentable.

## billing-wallet v1

| Operación | Petición | Respuesta | Errores de negocio |
| --- | --- | --- | --- |
| `GET /v1/wallets/{fleetId}` | — | `walletViewSchema` | `404 WALLET_NOT_FOUND` |
| `GET /v1/wallets/{fleetId}/transactions?limit=&cursor=` | `listWalletTransactionsQuerySchema` | `{items[], nextCursor?}` | `404 WALLET_NOT_FOUND` |
| `PUT /v1/debits/{debitId}` (SAGA paso 2) | `debitRequestSchema` `{sagaId, fleetId, energyKwh, connectorPowerKw}`; el importe lo calcula el servicio | `debitViewSchema` (`amount`, `pricing.{tariffMinorPerKwh, surgeMultiplierBasisPoints, surgeApplied}`) | `422 INSUFFICIENT_FUNDS`, `409 DEBIT_VOIDED`, `409 IDEMPOTENCY_CONFLICT`, `422 CURRENCY_MISMATCH` |
| `POST /v1/debits/{debitId}/refund` (compensación) | `{reason}` | `{debitId, status, outcome: REFUNDED \| ALREADY_REFUNDED \| NOTHING_TO_REFUND \| VOIDED}` | `404 DEBIT_NOT_FOUND` no aplica: un débito inexistente responde `VOIDED` |
| `PUT /v1/wallets/{fleetId}/top-ups/{topUpId}` (admin) | `{amount}` (> 0) | `{wallet, transaction}` | `422 CURRENCY_MISMATCH` |

Estados del débito: `DEBITED | REFUNDED | REJECTED_INSUFFICIENT_FUNDS | VOIDED`. Movimientos de billetera: `DEBIT | REFUND | TOP_UP`.

## energy-dispatch v1

| Operación | Petición | Respuesta | Errores de negocio |
| --- | --- | --- | --- |
| `PUT /v1/sessions/{sessionId}` (SAGA paso 3, pivote) | `activateSessionRequestSchema` `{sagaId, stationId, connectorId, energyKwh}` | `sessionViewSchema` (ACTIVE) | `422 CHARGER_HARDWARE_FAULT` (`chargerFaultProblemSchema`: `faultCode`, `simulated`), `409 SESSION_ABORTED`, `409 IDEMPOTENCY_CONFLICT` |
| `GET /v1/sessions/{sessionId}` | — | `sessionViewSchema` | `404 SESSION_NOT_FOUND` |
| `POST /v1/sessions/{id}/abort` (compensación) | `{reason}` | `{sessionId, status, outcome: ABORTED \| ALREADY_ABORTED \| ALREADY_FAILED \| VOIDED}` | `409 SESSION_ALREADY_COMPLETED` |
| `GET /v1/sessions/{id}/telemetry?limit=` | `listTelemetryQuerySchema` | `{items[]}` (`powerKw`, `energyDeliveredKwh`, `voltageV`, `temperatureC`) | `404 SESSION_NOT_FOUND` |

Estados: `ACTIVE | FAILED | ABORTED | COMPLETED | VOIDED`. Si la activación hace *timeout*, el orquestador consulta `GET /v1/sessions/{id}` antes de compensar.

## saga-orchestrator v1

| Operación | Petición | Respuesta | Errores de negocio |
| --- | --- | --- | --- |
| `POST /v1/sagas` (+ `idempotency-key`) | `startSagaRequestSchema` `{fleetId, stationId, connectorId, requestedEnergyKwh, fastChargeBoost=false}` | `201` (terminal) o `202` (en curso) con `sagaViewSchema` | `409 IDEMPOTENCY_KEY_CONFLICT` |
| `GET /v1/sagas/{sagaId}` | — | `sagaViewSchema` (estado, `terminal`, `failureReason`, `steps[]`) | `404 SAGA_NOT_FOUND` |
| `GET /v1/sagas/{sagaId}/events` | — | `{items[]}` (historial para el panel de compensaciones) | `404 SAGA_NOT_FOUND` |
| `GET /v1/sagas?fleetId=&status=&limit=` | `listSagasQuerySchema` | `{items[]}` | — |

Los estados, pasos, eventos y motivos de fallo están en el módulo y coinciden con [02-saga.md](../architecture/02-saga.md).

## feature-flags v1 (contrato de datos)

- Las claves son `ENABLE_DYNAMIC_SURGE_PRICING`, `ENABLE_FAST_CHARGE_BOOST` y `SIMULATE_CHARGER_HARDWARE_FAULT`.
- `FEATURE_FLAG_EVALUATORS` indica qué servicio evalúa cada flag.
- `featureFlagStateSchema` (`key`, `enabled`, `version`, `updatedAt`, `updatedBy`) describe el estado tal como lo leen los servicios desde `aegisvolt-feature-flags-<env>`.

## Versionado

Cada contrato tiene versión semántica (`API.version` o `CONTRACT.version`) y un prefijo de ruta con la versión mayor.

| Cambio | Tipo | Ejemplos |
| --- | --- | --- |
| Compatible para consumidores | **minor** (`1.x.0`) | campo **opcional** nuevo en una respuesta, nueva operación, nuevo código de error para una situación nueva, nueva flag |
| Corrección sin cambio de forma | **patch** (`1.0.x`) | documentación, mensajes de validación |
| Incompatible | **major** → nuevo módulo `v2` y ruta `/v2` | eliminar o renombrar un campo, volver obligatorio un campo opcional, cambiar un tipo o formato, quitar un valor de un enum de respuesta, cambiar el status HTTP de un error |

Reglas:
- Una versión mayor nueva convive con la anterior (`stationReservationV1` y `stationReservationV2`) hasta que todos los consumidores migren. Los proveedores sirven `/v1` y `/v2` en paralelo.
- Añadir un valor a un enum de **respuesta** es incompatible para un consumidor estricto. Por eso los consumidores validan estados con el enum de su misma versión y tratan los valores desconocidos como error controlado.
- Cada cambio se registra en `packages/contracts/CHANGELOG.md` en el mismo PR. Las pruebas de contrato (`packages/contracts/test`) y de alineación en cada servicio deben pasar.
