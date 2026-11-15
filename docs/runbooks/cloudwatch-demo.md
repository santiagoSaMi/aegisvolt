# Runbook: logs y métricas en CloudWatch (Floci)

Muestra la centralización de logs por ambiente, las métricas de la SAGA y el rastreo de una SAGA fallida por `correlation_id` ([ADR-0028](../adr/0028-logging-estructurado-operation-errores-tipados.md), [ADR-0029](../adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md)). Usa solo credenciales ficticias.

## 1. Preparar

```bash
scripts/floci/start.sh                         # Floci 2.4.0 con FLOCI_TLS_ENABLED=true (config/floci.env)
for e in dev test prod; do scripts/floci/terraform-live.sh $e apply; done
set -a; source infra/local/floci/config/aws-local.env; set +a
aws logs describe-log-groups --log-group-name-prefix /aegisvolt/ --query 'logGroups[].[logGroupName,retentionInDays]' --output table
```

Resultado: seis grupos por ambiente (cinco servicios y `unclassified`), con retención de 7, 14 y 30 días.

## 2. Qué soporta Floci (evidencia)

```bash
scripts/floci/cloudwatch-probe.sh
```

Imprime una tabla con cada operación de CloudWatch Logs y Metrics y si funciona. Se guarda en `infra/local/floci/.tmp/`. Resumen en [L-09](../limitations.md).

## 3. Recolección desde Kubernetes, de punta a punta

```bash
scripts/floci/logging-k8s-verify.sh --env dev     # ~5 min; --keep conserva el clúster
```

El script:

1. crea un clúster EKS (k3s) temporal en Floci;
2. despliega `infra/k8s/overlays/dev` (Fluent Bit);
3. lanza pods etiquetados como los cinco servicios, que escriben líneas con el esquema de ADR-0028;
4. comprueba en Floci:
   - grupo y stream por pod, con el JSON intacto;
   - el grupo de respaldo y el descarte de pods ajenos;
   - la traza por `correlation_id` en Logs Insights;
   - las métricas `SagaCompleted`, `SagaCompensated`, `SagaFailed`, `SagaCompensationFailed`, `SagaDuration` y `ServiceErrors`/`Http5xx` por servicio;
   - el paso de la alarma `aegisvolt-dev-saga-compensation-failed` a `ALARM`.

El informe queda en `infra/local/floci/.tmp/logging-k8s-verify-<id>.md`.

## 4. Rastrear una SAGA fallida por `correlation_id` (§6.4)

El `correlation_id` aparece en la consola web (Carga y Observabilidad), en `extensions.correlationId` de los errores GraphQL y en la cabecera `x-correlation-id`.

```bash
CID=<correlation_id>; G=/aegisvolt/dev
QID=$(aws logs start-query --start-time $(date -d '-1 hour' +%s) --end-time $(date +%s) \
  --log-group-names $G/graphql-api $G/saga-orchestrator-service $G/station-reservation-service \
                    $G/billing-wallet-service $G/energy-dispatch-service \
  --query-string "fields @timestamp, @log, operation, event, message | filter correlation_id = \"$CID\" | sort @timestamp asc" \
  --query queryId --output text)
aws logs get-query-results --query-id $QID

# Solo el orquestador, con patrón JSON: pasos fallidos con su error tipado
aws logs filter-log-events --log-group-name $G/saga-orchestrator-service \
  --filter-pattern "{ (\$.correlation_id = \"$CID\") && (\$.event = \"STEP_FAILED\") }"
```

## 5. Métricas y alarmas

```bash
aws cloudwatch get-metric-statistics --namespace AegisVolt/dev --metric-name SagaCompensated \
  --statistics Sum --start-time $(date -u -d '-1 hour' +%FT%TZ) --end-time $(date -u +%FT%TZ) --period 300
aws cloudwatch get-metric-statistics --namespace AegisVolt/dev --metric-name ServiceErrors \
  --dimensions Name=ServiceName,Value=billing-wallet-service --statistics Sum \
  --start-time $(date -u -d '-1 hour' +%FT%TZ) --end-time $(date -u +%FT%TZ) --period 300
aws cloudwatch describe-alarms --alarm-name-prefix aegisvolt-dev- --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
```

Las aplicaciones reales se desplegarán en el clúster en la fase de Kubernetes. Hasta entonces, la evidencia con los servicios reales es el E2E (`tests/e2e/.evidence/logs/`, ADR-0028), y la del colector es el paso 3.
