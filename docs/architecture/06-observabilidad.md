# 06 · Observabilidad: CloudWatch y Prefect

Cubre el punto 16. Decisión: [ADR-0014](../adr/0014-observabilidad-cloudwatch-fluent-bit-prefect.md).

## Logs estructurados

Todos los servicios escriben **una línea JSON por evento en stdout**. No conocen CloudWatch: aplican el principio 12-factor e inversión de dependencias.

```json
{"timestamp":"2026-11-12T22:10:36.123Z","level":"info","service":"billing-wallet-service",
 "environment":"test","version":"sha-1a2b3c4","correlation_id":"c-123","saga_id":"s-456",
 "event":"debit.refunded","http_status":200,"duration_ms":38,"message":"Debit refunded",
 "debit_id":"d-789","amount_minor":125000}
```

- **Campos obligatorios:** `timestamp`, `level`, `service`, `environment`, `correlation_id` y `message`. CLAUDE.md añade `saga_id` cuando existe y `version` para el canary.
- **Prohibido en logs:** tokens, contraseñas y datos personales completos; el logger aplica *redaction*.

## Envío a CloudWatch Logs

- **Fluent Bit** corre como DaemonSet en el namespace `logging` y lee los logs de los contenedores. Su salida `cloudwatch_logs` envía cada app a `/aegisvolt/<env>/<service>`, con un log stream por pod.
- Los log groups los crea **Terraform** (módulo `observability`) con retención: 7 días en `dev`, 14 en `test` y 30 en `prod`. Fluent Bit no los auto-crea.
- En local, el *endpoint* de la salida apunta a `http://floci:4566`. La opción de endpoint personalizado del plugin y su compatibilidad con Floci **se verificarán** en la fase de observabilidad.
- **Alternativa registrada si la verificación falla:** un adaptador `CloudWatchLogSink`, detrás del puerto del logger, que envía lotes con `PutLogEvents` desde cada servicio. El dominio no cambia en ningún caso.

## Métricas

- **Metric filters** de CloudWatch Logs, verificados en Floci:
  - `HttpErrors` (`http_status >= 500`)
  - `SagaCompensated` (`event = saga.compensated`)
  - `SagaRequiresAttention`
  - en el namespace `AegisVolt/<env>`.
- **Alarmas de una sola métrica**, que es lo que Floci evalúa según su documentación: `SagaRequiresAttention > 0` y tasa de `HttpErrors`.
- El análisis canary calcula la tasa en el cliente porque Floci no soporta *metric math* ([05](05-infraestructura-y-despliegue.md)).

## Trazabilidad por `correlation_id` (§6.4)

```bash
aws logs filter-log-events --log-group-name-prefix /aegisvolt/test/ \
  --filter-pattern '{ $.correlation_id = "c-123" }'
```

- Devuelve la línea temporal completa de una SAGA fallida en los cuatro servicios, incluidas las acciones del `RecoveryWorker`, que reutiliza el mismo `correlation_id`.
- El filtro con patrón JSON debe verificarse en Floci; el patrón por texto (`"c-123"`) ya está verificado.
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
