# ADR-0029: CloudWatch por ambiente: Fluent Bit como colector, log groups y métricas de la SAGA desde Terraform

- **Estado:** Aceptado
- **Fecha:** 2026-11-14
- **Concreta:** [ADR-0014](0014-observabilidad-cloudwatch-fluent-bit-prefect.md) (verificaciones pendientes) y [ADR-0028](0028-logging-estructurado-operation-errores-tipados.md) (esquema de logs)

## Contexto

§2.5 exige centralizar logs JSON en CloudWatch, en grupos separados por ambiente (`/aegisvolt/dev|test|prod/...`). La rúbrica (§5, punto 4; §6.4) exige rastrear en CloudWatch el `correlation_id` de una SAGA fallida. ADR-0014 eligió Fluent Bit, pero dejó dos cosas por verificar: su compatibilidad con Floci y qué operaciones de CloudWatch funcionan de verdad en Floci. Esta fase además define las métricas: SAGA completadas, compensadas y fallidas, su duración, y los errores por servicio.

## Verificación en Floci 2.4.0 (2026-11-14)

### CloudWatch Logs y Metrics

La documentación de Floci describe la versión más reciente, no la 2.4.0 fijada. Por eso se comprobó cada operación con `scripts/floci/cloudwatch-probe.sh`, que crea recursos temporales y verifica también el comportamiento, no solo la respuesta:

| Funciona | No funciona |
| --- | --- |
| CreateLogGroup, PutRetentionPolicy, DescribeLogGroups, TagResource | Logs Insights `stats … by` (la consulta termina `Failed`) |
| CreateLogStream, PutLogEvents, GetLogEvents | EMF (Embedded Metric Format): no extrae métricas |
| FilterLogEvents con texto y con patrones JSON: igualdad, numéricos (`>=`) y anidados (`$.error.code`) | *Metric math* en GetMetricData (sin resultado) |
| Logs Insights `fields`, `filter` y `sort` sobre **varios** grupos | |
| PutMetricFilter, DescribeMetricFilters y TestMetricFilter | |
| **Metric filters que generan métricas**: contador, **valor desde un campo** (`$.duration_ms`) y **dimensión desde un campo** (`$.service_name`) | |
| PutMetricData, ListMetrics, GetMetricStatistics, GetMetricData (MetricStat) | |
| PutMetricAlarm con **evaluación real** (pasa a `ALARM`), SetAlarmState, DescribeAlarmHistory | |
| PutDashboard y GetDashboard (se guardan; Floci no los renderiza) | |

### Colector

Se probó Fluent Bit 5.1.5 contra Floci 2.4.0:

- El plugin `cloudwatch_logs` **siempre usa TLS**: ignora `tls: off`. Contra el HTTP de Floci falla con `SSL routines::wrong version number`. El ejemplo con LocalStack de la documentación funciona porque LocalStack sirve HTTP y HTTPS en el mismo puerto.
- Floci 2.4.0 hace lo mismo con `FLOCI_TLS_ENABLED=true`: HTTP y HTTPS en el puerto 4566, CA local y SAN de `FLOCI_HOSTNAME` (`floci`). Primero se verificó en un contenedor desechable y luego en el Floci del proyecto. Los clientes HTTP existentes no cambian.
- Con `tls.verify: on` y `tls.ca_file` apuntando a la CA de Floci, Fluent Bit entrega los eventos al grupo y stream calculados por las plantillas, con la línea JSON intacta.

## Decisión

### Colector: Fluent Bit 5.1.5 como DaemonSet

- **Imagen:** `fluent/fluent-bit:5.1.5`, publicada el 2026-10-20 y fijada por digest. Plugin nativo `cloudwatch_logs`.
- **Entrada:** `tail` de `/var/log/containers/*.log` con el parser `cri` (containerd en EKS y k3s). La posición de lectura y el búfer van en disco, en `hostPath`, para no perder logs si CloudWatch no responde o el pod se reinicia.
- **Filtros:**
  - `kubernetes`, solo lectura de pods y namespaces;
  - `grep`, que envía **solo** los pods con la etiqueta `app.kubernetes.io/part-of=aegisvolt`. La decisión se toma por la etiqueta del manifiesto, nunca por el contenido del log.
- **Salida:**
  - grupo `/aegisvolt/<env>/<app.kubernetes.io/name>` (`log_group_template`);
  - un **stream por pod** (`log_stream_template`);
  - `log_key: log`: se envía la línea JSON original de ADR-0028, sin metadatos;
  - `auto_create_group: false`, porque los grupos los crea Terraform;
  - si un pod de AegisVolt no tiene `app.kubernetes.io/name`, el log va a `/aegisvolt/<env>/unclassified`.
- **Ambiente:** lo fija el overlay (`AEGISVOLT_ENV`), uno por clúster según ADR-0012. No se deduce de los logs.
- **Kustomize:**
  - `base/logging`: salida para AWS real;
  - `components/floci`, solo local: salida hacia el Service `floci` con TLS verificado contra la CA de Floci, Secret con credenciales ficticias y Service sin selector (L-07);
  - `overlays/<env>`.
- **Seguridad del pod:** corre como root solo para leer `/var/log` del nodo, con `readOnlyRootFilesystem`, sin capacidades, sin escalada de privilegios y con `seccomp RuntimeDefault`. En AWS real, el rol IRSA o Pod Identity solo debe permitir `logs:CreateLogStream`, `logs:PutLogEvents` y `logs:DescribeLogStreams` sobre `/aegisvolt/<env>/*`.

### Log groups, métricas y alarmas: Terraform (`modules/observability`)

- **Raíz y estado:**
  - `infra/terraform/live` es la raíz única; el workspace es el ambiente, y otro workspace hace fallar el plan;
  - estado en `s3://aegisvolt-tfstate/env:/<env>/aegisvolt/terraform.tfstate`, con versionado y `use_lockfile`;
  - el bucket lo crea `infra/terraform/bootstrap`.
- **Grupos:** `/aegisvolt/<env>/<servicio>` para las cinco unidades, más `unclassified`. Retención: 7 días en `dev`, 14 en `test` y 30 en `prod`.
- **Métricas** (metric filters, namespace `AegisVolt/<env>`):

| Métrica | Origen (log group) | Patrón | Valor | Dimensión |
| --- | --- | --- | --- | --- |
| `SagaCompleted` | saga-orchestrator | `{ ($.component = "saga") && ($.event = "SAGA_COMPLETED") }` | 1 | — |
| `SagaCompensated` | saga-orchestrator | `… $.event = "SAGA_COMPENSATED"` | 1 | — |
| `SagaFailed` | saga-orchestrator | `… $.event = "SAGA_FAILED"` | 1 | — |
| `SagaCompensationFailed` | saga-orchestrator | `… $.event = "SAGA_COMPENSATION_FAILED"` | 1 | — |
| `SagaDuration` (ms) | saga-orchestrator | `{ ($.component = "saga") && ($.duration_ms >= 0) }` | `$.duration_ms` | — |
| `ServiceErrors` | cada servicio | `{ ($.level = "error") \|\| ($.level = "fatal") }` | 1 | `ServiceName = $.service_name` |
| `Http5xx` | cada servicio | `{ ($.event = "http_request") && ($.http_status >= 500) }` | 1 | `ServiceName = $.service_name` |

  `duration_ms` (de la creación de la SAGA a su estado terminal) solo lo añade el orquestador a los eventos terminales, así que cada SAGA aporta exactamente un valor a `SagaDuration`.

- **Alarmas de una sola métrica**, las que Floci evalúa:
  - `aegisvolt-<env>-saga-compensation-failed`: `SagaCompensationFailed > 0` en 60 s. Requiere el reintento controlado del runbook.
  - `aegisvolt-<env>-<servicio>-errors`: `ServiceErrors >= umbral` en 5 min; el umbral es 5, o 3 en `prod`.
  - Sin acciones por ahora; el SNS se definirá con el canary.
- **Dashboard** `aegisvolt-<env>` con resultados de la SAGA, duración (media y p90), errores y 5xx por servicio. En Floci solo se almacena.

## Alternativas

1. **OpenTelemetry Collector** (`awscloudwatchlogs` exporter). Es más versátil (trazas, métricas) y neutral respecto del proveedor, pero es más pesado y la especificación solo pide logs en CloudWatch. Además habría que repetir la verificación de compatibilidad (endpoint, TLS) con otro componente. Fluent Bit es el colector que AWS documenta para EKS, y aquí quedó verificado.
2. **Envío desde el código** (`CloudWatchLogSink` con `PutLogEvents`). Era la alternativa de ADR-0014 si Fluent Bit no funcionaba. Acopla los servicios a CloudWatch y añade latencia y fallos de red a cada petición. Ya no hace falta.
3. **`tls.verify: off` en lugar de la CA de Floci.** Funcionaría, pero normaliza no verificar certificados. Validar contra la CA local cuesta lo mismo y es lo correcto.
4. **Proxy TLS dentro del clúster** delante del HTTP de Floci. Es una pieza más que operar, cuando Floci ya ofrece TLS nativo.
5. **EMF** (métricas embebidas en los logs). No funciona en Floci 2.4.0, y los metric filters cubren lo pedido sin cambiar los logs.
6. **Métricas con `PutMetricData` desde el orquestador.** Acoplaría el dominio a CloudWatch; los metric filters derivan las métricas de los logs que ya existen.
7. **`auto_create_group: true` en Fluent Bit.** Crearía grupos sin retención ni etiquetas y fuera de Terraform (CLAUDE.md).

## Consecuencias

- **Positivas:**
  - Las aplicaciones solo escriben en stdout. El colector, los grupos y las métricas son infraestructura declarada y verificada contra Floci.
  - Una búsqueda por `correlation_id` (FilterLogEvents en un grupo, o Logs Insights `fields`/`filter`/`sort` sobre los grupos del ambiente) reconstruye una SAGA fallida.
- **Negativas:**
  - Floci 2.4.0 no ejecuta Logs Insights `stats`, *metric math* ni EMF. Las agregaciones se hacen con metric filters y `GetMetricStatistics`, y Prefect las calcula en el cliente.
  - El Floci local debe correr con `FLOCI_TLS_ENABLED=true`, y la CA (generada en cada instalación) se entrega al clúster como ConfigMap.
  - Con TLS, Cognito de Floci emite `iss = https://floci:4566/<pool>` en lugar de `http://`. Se actualizó `COGNITO_ISSUER` (E2E, `.env.example`, guía GraphQL), y queda más cerca de AWS real, donde el emisor siempre es HTTPS. Detectado por el E2E.
  - La IP de Floci en el EndpointSlice se sustituye al desplegar, hasta fijarla en el compose (fase de K8s).
