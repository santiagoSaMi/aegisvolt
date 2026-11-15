# 06 · Observabilidad: CloudWatch y Prefect

Cubre el punto 16. Decisión: [ADR-0014](../adr/0014-observabilidad-cloudwatch-fluent-bit-prefect.md).

## Logs estructurados

Todos los servicios escriben **una línea JSON por evento en stdout**. No conocen CloudWatch: aplican el principio 12-factor e inversión de dependencias.

Ejemplo real (E2E, falla de hardware simulada). La misma SAGA en dos servicios:

```json
{"level":"warn","timestamp":"2026-11-15T00:47:17.718Z","service_name":"saga-orchestrator-service",
 "environment":"local","version":"e2e","correlation_id":"eb4785c5-…","saga_id":"saga_016bb3fc-…",
 "operation":"ReserveAndActivateCharging","event":"STEP_FAILED","step":"ACTIVATION",
 "error":{"type":"SagaStepFailure","code":"CHARGER_HARDWARE_FAULT","message":"Paso ACTIVATION fallido"},
 "message":"Evento de la SAGA"}
{"level":"info","timestamp":"2026-11-15T00:47:17.735Z","service_name":"billing-wallet-service",
 "environment":"local","version":"e2e","correlation_id":"eb4785c5-…","saga_id":"saga_016bb3fc-…",
 "operation":"RefundWallet","event":"http_request","method":"POST","http_status":200,
 "duration_ms":10.6,"message":"Petición HTTP"}
```

- **Campos de cada línea** ([ADR-0028](../adr/0028-logging-estructurado-operation-errores-tipados.md)):
  - siempre: `timestamp`, `level`, `environment`, `service_name`, `version`, `correlation_id` (`null` fuera de una petición o SAGA), `operation` y `message`;
  - cuando aplica: `saga_id`;
  - cuando hay error: `error` = `{ type, code?, message, stack?, cause? }`. Los errores esperados (con `code`) no llevan stack.
- **`operation`:**
  - en los servicios, el caso de uso de la ruta (`logOperation('DebitWallet')`);
  - en el graphql-api, `<tipo>.<nombre>` de la operación GraphQL;
  - en procesos sin petición: `Startup`, `Shutdown`, `RecoverSagas`;
  - en los eventos de la SAGA: `ReserveAndActivateCharging`.
- **Propagación:** `x-correlation-id` y `x-saga-id` en cada llamada HTTP entre procesos (ADR-0009).
- **Prohibido en logs:**
  - tokens, credenciales y secretos;
  - cabeceras, cuerpos y *query strings*;
  - datos personales: el logger aplica *redaction*, y la identidad del usuario no se registra.

## Envío a CloudWatch Logs

Decisión y verificación: [ADR-0029](../adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md).

- **Fluent Bit 5.1.5** corre como DaemonSet en el namespace `logging` (`infra/k8s/base/logging`). Lee los logs CRI de los contenedores y solo envía los pods con `app.kubernetes.io/part-of=aegisvolt`:
  - cada servicio va a `/aegisvolt/<env>/<app.kubernetes.io/name>`;
  - un log stream por pod;
  - la línea JSON original (`log_key: log`);
  - si un pod de AegisVolt no tiene nombre, a `/aegisvolt/<env>/unclassified`.
- Los log groups los crea **Terraform** (`infra/terraform/modules/observability`, workspaces `dev`/`test`/`prod`) con retención de 7, 14 y 30 días. Fluent Bit no los auto-crea.
- **Local:** el componente `infra/k8s/components/floci` envía a Floci por **HTTPS** (Service `floci` sin selector, certificado validado con la CA local de Floci). El plugin no admite HTTP, así que Floci corre con `FLOCI_TLS_ENABLED=true`.
- **Verificado de punta a punta** con `scripts/floci/logging-k8s-verify.sh`: clúster EKS de Floci, cinco servicios, respaldo, pods ajenos descartados, métricas y alarma. La alternativa `CloudWatchLogSink` de ADR-0014 ya no es necesaria.

## Métricas

**Metric filters** declarados en Terraform, namespace `AegisVolt/<env>`, verificados en Floci con datos reales del colector:

| Métrica | Qué mide | Valor / dimensión |
| --- | --- | --- |
| `SagaCompleted`, `SagaCompensated`, `SagaFailed`, `SagaCompensationFailed` | SAGAs por resultado terminal (`event` del orquestador) | 1 por SAGA |
| `SagaDuration` | Duración de creación a estado terminal | `$.duration_ms` (ms) |
| `ServiceErrors` | Líneas `level` `error`/`fatal` | dimensión `ServiceName` |
| `Http5xx` | Peticiones con `http_status >= 500` | dimensión `ServiceName` |

- **Alarmas de una sola métrica** (Floci las evalúa; verificado):
  - `aegisvolt-<env>-saga-compensation-failed`: `SagaCompensationFailed > 0`;
  - `aegisvolt-<env>-<servicio>-errors`: `ServiceErrors >= umbral` en 5 min.
- **Dashboard** `aegisvolt-<env>`: en Floci solo se guarda.
- El análisis canary calcula la tasa en el cliente porque Floci no soporta *metric math* ([05](05-infraestructura-y-despliegue.md)).

## Trazabilidad por `correlation_id` (§6.4)

`filter-log-events` trabaja sobre **un** log group (no admite prefijo). Para toda la traza del ambiente se usa Logs Insights sobre los grupos, que en Floci admite `fields`, `filter` y `sort` (L-09):

```bash
G=/aegisvolt/test
aws logs start-query --start-time $(date -d '-1 hour' +%s) --end-time $(date +%s) \
  --log-group-names $G/graphql-api $G/saga-orchestrator-service $G/station-reservation-service \
                    $G/billing-wallet-service $G/energy-dispatch-service \
  --query-string 'fields @timestamp, @log, operation, event, message
                  | filter correlation_id = "c-123" | sort @timestamp asc'
aws logs get-query-results --query-id <id>

# Un solo servicio, con patrón JSON (verificado)
aws logs filter-log-events --log-group-name $G/saga-orchestrator-service \
  --filter-pattern '{ $.correlation_id = "c-123" }'
```

- La consulta devuelve la línea temporal completa de una SAGA fallida en todos los servicios, incluidas las acciones del `RecoveryWorker`, que reutiliza el mismo `correlation_id`. Se verificó con 5 grupos en `logging-k8s-verify.sh`.
- El flujo de Prefect `trace_correlation` automatiza esta consulta.

## Prefect

Decisión vigente: [ADR-0030](../adr/0030-prefect-auditoria-solo-lectura-por-apis.md), que reemplaza la lectura directa de DynamoDB de ADR-0014. Proyecto en [`prefect/`](../../prefect/README.md), con **Prefect 3.9.0**, Prefect Server local y su dashboard. Es un plano de observabilidad **transversal**: su base de metadatos es interna a Prefect y no son datos de AegisVolt (P-18).

| Flow | Programación (`serve`) | Fuente (solo GET a las APIs) | Salida |
| --- | --- | --- | --- |
| `environment_health_monitor` | cada 5 min | `/health/live` y `/health/ready` de las 5 unidades de cada ambiente; existencia de los log groups | Tabla y resumen; `EnvironmentHealthy`, `ServiceReady`; Failed si algún ambiente no está OPERATIONAL |
| `saga_consistency_audit` | cada 10 min | `GET /v1/audit/sagas` (orquestador, por estado) y sesiones | SAGA-001 a SAGA-005 |
| `reservation_consistency_audit` | cada 15 min | Reservas por flota, SAGA y sesión | RES-001 a RES-005 |
| `billing_consistency_audit` | cada 15 min | Libro mayor por flota, débito, SAGA y sesión | BIL-001 a BIL-006 |

- Cada hallazgo cita su regla (enunciado y justificación) y los hechos observados. Se publican artifacts (markdown y tabla) y métricas `AegisVolt/Audit` (`Findings`, `FindingsByRule`, `AuditErrors`).
- Prefect **no** lee tablas ajenas ni escribe datos de negocio, y **no** es un segundo orquestador: detecta y reporta, y la reparación la hace el orquestador (recuperación) o una persona con el runbook.
- La traza de un `correlation_id` se consulta con Logs Insights o FilterLogEvents (sección anterior). El flow `trace_correlation` de ADR-0014 no forma parte del alcance pedido para Prefect.
