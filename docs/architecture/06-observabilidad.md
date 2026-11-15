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

**Despliegue:** `prefect server start` y un worker de tipo *process*, en contenedores en `infra/local/prefect/`, con **Prefect 3.x** (última verificada: 3.9.2). Es un plano de observabilidad **transversal** que supervisa los tres ambientes, como pide §2.5. Su base de datos de metadatos es interna a Prefect, no forma parte de los datos de AegisVolt y no contradice "uso exclusivo de DynamoDB" (P-18).

| Flow | Programación | Tasks | Salida |
| --- | --- | --- | --- |
| `environment_health` | cada 5 min, parámetro `envs=["dev","test","prod"]` | Por ambiente: `/health/ready` de cada app (a través de la API `/ops`), `DescribeTable` de las 5 tablas, lectura de flags, existencia de los log groups | *Table artifact* con el estado por ambiente; el flow falla si algún ambiente está degradado |
| `saga_consistency_audit` | cada 10 min | Por ambiente, de solo lectura: (1) SAGAs no terminales con más de 5 min (**huérfanas**); (2) `COMPENSATED` → reserva `RELEASED`/`VOIDED`, débito `REFUNDED`/`REJECTED`/`VOIDED`, sesión no `ACTIVE`; (3) `COMPLETED` → reserva `CONFIRMED`, débito `DEBITED`, sesión `ACTIVE`/`COMPLETED`; (4) *holds* vencidos sin SAGA; (5) `COMPENSATION_FAILED` sin reintento programado (requiere reintento controlado) | *Table* y *markdown artifacts* con las inconsistencias; métricas `AegisVolt/Audit` (`OrphanSagas`, `CompensatedSagas`, `InconsistentSagas`) con `PutMetricData` |
| `trace_correlation` | a demanda, parámetro `correlation_id` | `FilterLogEvents` sobre `/aegisvolt/<env>/*` | *Markdown artifact* con la línea temporal ordenada |

- Prefect lee DynamoDB y CloudWatch con **boto3**, con el endpoint configurable: `http://localhost:4566` en local.
- Las credenciales de Prefect son de solo lectura: en AWS real, un rol IAM con `dynamodb:Query/GetItem/DescribeTable` sobre `aegisvolt-*`, `logs:FilterLogEvents` y `cloudwatch:PutMetricData`.
- Prefect **no** escribe en tablas de negocio: detecta y reporta, y la reparación la hace el orquestador o el runbook.
