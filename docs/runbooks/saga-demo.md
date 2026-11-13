# Runbook · Demostración de la SAGA "Reservar y Activar Carga" con datos de DynamoDB (Floci)

Objetivo: demostrar con **ítems reales de DynamoDB en Floci** los escenarios de éxito y de fallo de la SAGA (§2.3, §6.3), la idempotencia de las compensaciones y la recuperación tras un reinicio. Diseño: [02-saga.md](../architecture/02-saga.md) y [ADR-0024](../adr/0024-saga-orquestada-implementacion-estados-lease-recuperacion.md).

> Lo que se demuestra son **compensaciones** (operaciones de negocio inversas, idempotentes y verificadas), no un *rollback* ACID: cada servicio confirmó su paso en su propia tabla y el orquestador lo revierte con otra operación.

## 1. Demostración automática (recomendada)

```bash
scripts/floci/start.sh                       # Floci 2.4.0 en http://localhost:4566
REQUIRE_INTEGRATION=true pnpm test:e2e       # ~11 s
ls tests/e2e/.evidence/                      # un JSON por escenario + logs de los 4 servicios
```

`pnpm test:e2e` ([tests/e2e](../../tests/e2e/README.md)) hace lo siguiente:
1. Crea tablas temporales `aegisvolt-*-e2e-<sufijo>` en Floci.
2. Levanta los **cuatro servicios reales** como procesos Node (puertos 24100–24103).
3. Pone un proxy de inyección de fallos delante de billing (solo para los escenarios 5 y 6).
4. Ejecuta los escenarios por HTTP y verifica los ítems de las cinco tablas.
5. Guarda en `tests/e2e/.evidence/<escenario>.json` un **resumen** (`summary`) y los **ítems completos** (`raw`).
6. Borra las tablas al terminar. `E2E_KEEP_TABLES=true` las conserva para inspeccionarlas con `aws dynamodb`.

Credenciales: solo las ficticias del emulador (`test`/`test`). El harness rechaza endpoints que no sean `localhost`.

## 2. Evidencia obtenida (ejecución del 2026-11-13 contra Floci 2.4.0)

Extractos de `tests/e2e/.evidence/*.json`. Los ids cambian en cada ejecución.

### 2.1 Éxito → `COMPLETED`

| Tabla | Ítem | Valor |
| --- | --- | --- |
| sagas | `SAGA#saga_9cb12d28…` | `status: COMPLETED`, `version: 9`, `correlationId: 3c6c7896…` |
| reservations | `RES#res_9cb12d28…` | `status: CONFIRMED` |
| reservations | `STATION#st_e2e-norte-01 / CONN#cn_01` | `status: OCCUPIED`, `holdReservationId: res_9cb12d28…` |
| billing | `DEBIT#dbt_9cb12d28…` | `status: DEBITED`, `amountMinor: 3000000` |
| billing | `WALLET#fleet_e2e-rica / TX#…` | `DEBIT 3000000 → balanceAfter 47000000`, `correlationId: 3c6c7896…` |
| dispatch | `SESSION#ses_9cb12d28…` | `status: ACTIVE` |

Eventos (`SAGA#… / EVT#…`):

```text
0 SAGA_STARTED → 1 STEP_STARTED RESERVATION → 2 STEP_SUCCEEDED RESERVATION (RESERVATION_COMPLETED)
→ 3 STEP_STARTED DEBIT → 4 STEP_SUCCEEDED DEBIT (BILLING_COMPLETED)
→ 5 STEP_STARTED ACTIVATION → 6 STEP_SUCCEEDED ACTIVATION (DISPATCH_COMPLETED)
→ 7 STEP_STARTED CONFIRMATION → 8 STEP_SUCCEEDED CONFIRMATION (COMPLETED) → 9 SAGA_COMPLETED
```

**Repetición de la petición inicial** (misma `idempotency-key`):
- respuesta `201` con la misma SAGA y el `correlationId` original;
- el libro mayor sigue con **un** `DEBIT` y el saldo sigue en `47000000`.

### 2.2 Fondos insuficientes → liberación de la reserva → `COMPENSATED`

| Tabla | Ítem | Valor |
| --- | --- | --- |
| sagas | Saga | `COMPENSATED`, `failureReason: INSUFFICIENT_FUNDS`, `failedStep: DEBIT`, `compensationPlan: [RELEASE_RESERVATION]` |
| reservations | Reserva / conector `cn_02` | `RELEASED` / `AVAILABLE` |
| billing | Débito | `REJECTED_INSUFFICIENT_FUNDS` (sin movimiento en el libro mayor) |
| billing | Billetera `fleet_e2e-pobre` | `balanceMinor: 1000000` (intacto) |
| dispatch | Sesión | no existe (no se llegó a activar) |

```text
… 3 STEP_STARTED DEBIT → 4 STEP_FAILED DEBIT [INSUFFICIENT_FUNDS] (COMPENSATING)
→ 5 COMPENSATION_STARTED → 6 COMPENSATION_STEP_STARTED RELEASE_RESERVATION
→ 7 COMPENSATION_SUCCEEDED RELEASE_RESERVATION (COMPENSATED) → 8 SAGA_COMPENSATED
```

### 2.3 Fallo de hardware (flag `SIMULATE_CHARGER_HARDWARE_FAULT = true` en la tabla de flags) → reembolso y liberación → `COMPENSATED`

| Tabla | Ítem | Valor |
| --- | --- | --- |
| sagas | Saga | `COMPENSATED`, `failureReason: CHARGER_HARDWARE_FAULT`, `compensationPlan: [REFUND_DEBIT, RELEASE_RESERVATION]` |
| dispatch | Sesión | `FAILED`, `faultCode: E-HW-001`, `faultSimulated: true` |
| billing | Débito | `REFUNDED`, `refundId: rfd_…` |
| billing | `REFUND#rfd_…` | `amountMinor: 3000000`, `reason: CHARGER_HARDWARE_FAULT` |
| billing | Libro mayor | `DEBIT 3000000 → 44000000` y luego `REFUND 3000000 → 47000000` (mismo `correlationId`) |
| reservations | Reserva / conector `cn_03` | `RELEASED` / `AVAILABLE` |

```text
… 6 STEP_FAILED ACTIVATION [CHARGER_HARDWARE_FAULT] (COMPENSATING) → 7 COMPENSATION_STARTED
→ 8 COMPENSATION_STEP_STARTED REFUND_DEBIT → 9 COMPENSATION_SUCCEEDED REFUND_DEBIT
→ 10 COMPENSATION_STEP_STARTED RELEASE_RESERVATION → 11 COMPENSATION_SUCCEEDED RELEASE_RESERVATION (COMPENSATED)
→ 12 SAGA_COMPENSATED
```

### 2.4 Compensación procesada dos veces (§6.3)

Se repiten a mano las compensaciones de 2.3 con las cabeceras de la SAGA:
- `POST /v1/debits/{id}/refund` → `ALREADY_REFUNDED`;
- `POST /v1/reservations/{id}/release` → `ALREADY_RELEASED`.

El saldo (`47000000`) y el número de movimientos (2) **no cambian**. La condición de DynamoDB (`status = DEBITED` + versión) impide el segundo reembolso de forma atómica.

### 2.5 Reinicio con un paso intermedio persistido

El proxy deja pasar el débito a billing (que lo aplica) pero retiene la respuesta, y el orquestador recibe `SIGKILL`.

Estado persistido antes de reiniciar (`05a-reinicio-antes.json`):

```text
saga:    RESERVATION_COMPLETED · steps.DEBIT = {status: IN_PROGRESS, attempts: 1} · version 4
débito:  DEBITED (billing ya cobró)          libro mayor: 1 DEBIT
eventos: 0 SAGA_STARTED · 1 STEP_STARTED RESERVATION · 2 STEP_SUCCEEDED RESERVATION · 3 STEP_STARTED DEBIT
```

Se arranca un proceso nuevo del orquestador y su worker retoma la SAGA cuando vence el *lease* (`05b-reinicio-despues.json`):

```text
… 3 STEP_STARTED DEBIT → 4 RECOVERED → 5 STEP_STARTED DEBIT (misma clave dbt_…: billing responde 200, repetición)
→ 6 STEP_SUCCEEDED DEBIT → … → 10 STEP_SUCCEEDED CONFIRMATION (COMPLETED) → 11 SAGA_COMPLETED
libro mayor: sigue habiendo UN solo DEBIT (sin doble cobro) · sesión ACTIVE · reserva CONFIRMED
```

### 2.6 Fallo durante la compensación y recuperación tras reiniciar

Con la flag de fallo activa, el proxy responde `503` a los reembolsos.

Resultado `202` con la SAGA en `COMPENSATION_FAILED` (`06a-compensacion-fallida.json`):

```text
compensationFailure: {step: REFUND_DEBIT, errorCode: SERVICE_UNAVAILABLE, round: 1, nextAttemptAt: …}
steps.REFUND_DEBIT = FAILED (2 intentos) · steps.RELEASE_RESERVATION = PENDING
débito: DEBITED · reserva: HELD · conector: RESERVED   ← NO se marcó como compensada
… 8 COMPENSATION_STEP_STARTED REFUND_DEBIT → 9 COMPENSATION_STEP_FAILED [SERVICE_UNAVAILABLE]
→ 10 COMPENSATION_STEP_STARTED REFUND_DEBIT → 11 COMPENSATION_STEP_FAILED → 12 SAGA_COMPENSATION_FAILED
```

Se mata el orquestador, billing vuelve a responder y un proceso nuevo retoma la SAGA (`06b-compensacion-recuperada.json`):

```text
13 COMPENSATION_RETRY_REQUESTED REFUND_DEBIT [AUTOMATIC] → 14 COMPENSATION_STEP_STARTED REFUND_DEBIT
→ 15 COMPENSATION_SUCCEEDED REFUND_DEBIT → 16 … RELEASE_RESERVATION → 17 COMPENSATION_SUCCEEDED (COMPENSATED)
→ 18 SAGA_COMPENSATED · débito REFUNDED · reserva RELEASED · conector AVAILABLE
```

### 2.7 Trazabilidad

Todas las líneas de log de los cuatro servicios (`tests/e2e/.evidence/logs/*.log`) de una SAGA llevan el mismo `correlation_id` y su `saga_id`. Por ejemplo, la falla simulada en energy-dispatch:

```json
{"level":"warn","service":"energy-dispatch-service","component":"simulated-charger","correlation_id":"7d40eec7-…","saga_id":"saga_43f599b7-…","event":"charger_fault","fault_class":"PHYSICAL","fault_code":"E-HW-001","simulated":true}
```

## 3. Demostración manual en vivo (servicios en `dev` local)

```bash
# Tablas y flags locales (solo Floci)
pnpm --filter @aegisvolt/feature-flags flags:create-local-table local
for s in station-reservation billing-wallet energy-dispatch saga-orchestrator; do
  pnpm --filter "@aegisvolt/$s-service" db:create-local-table
done
pnpm dev                                                   # los cuatro servicios con su .env

# Activar la falla y disparar la SAGA
scripts/flags/set.sh local SIMULATE_CHARGER_HARDWARE_FAULT true
curl -s -X POST localhost:4100/v1/sagas -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" -H "x-correlation-id: $(uuidgen)" \
  -d '{"fleetId":"fleet_demo","stationId":"st_demo-01","connectorId":"cn_01","requestedEnergyKwh":30}'

# Inspeccionar DynamoDB (credenciales ficticias)
aws --endpoint-url http://localhost:4566 dynamodb get-item --table-name aegisvolt-sagas-local \
  --key '{"PK":{"S":"SAGA#<sagaId>"},"SK":{"S":"META"}}'
aws --endpoint-url http://localhost:4566 dynamodb query --table-name aegisvolt-sagas-local \
  --key-condition-expression 'PK = :pk AND begins_with(SK, :e)' \
  --expression-attribute-values '{":pk":{"S":"SAGA#<sagaId>"},":e":{"S":"EVT#"}}'
aws --endpoint-url http://localhost:4566 dynamodb get-item --table-name aegisvolt-billing-local \
  --key '{"PK":{"S":"DEBIT#<debitId>"},"SK":{"S":"META"}}'
```

Antes de disparar la SAGA hace falta registrar la estación (`PUT /v1/stations/{id}` en el puerto 4101) y abrir y recargar la billetera (`PUT /v1/wallets/{fleetId}` y `PUT /v1/wallets/{fleetId}/top-ups/tup_<uuid>` en el puerto 4102). Los cuerpos están en `tests/e2e/test/saga.e2e.test.ts`.

Operación ante `COMPENSATION_FAILED` sin reintento programado:

```bash
curl -s -X POST localhost:4100/v1/sagas/<sagaId>/compensation/retry -H "x-correlation-id: $(uuidgen)"
# o, como tarea controlada (Job de Kubernetes):
pnpm --filter @aegisvolt/saga-orchestrator-service saga:recover --retry <sagaId>
```
