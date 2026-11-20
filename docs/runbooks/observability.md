# Runbook: observabilidad (CloudWatch y Prefect, Floci)

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

Con las aplicaciones desplegadas en el clúster `dev` (`scripts/floci/k8s-deploy.sh dev`), `scripts/floci/k8s-verify.sh dev` comprueba además que una SAGA real deja sus logs en los cinco grupos y que su métrica (`SagaCompleted` o `SagaCompensated`, según la flag de falla del ambiente) aumenta. Sin clúster, la evidencia con los servicios reales es el E2E (`tests/e2e/.evidence/logs/`, ADR-0028).

## 6. Prefect: salud de los ambientes y auditoría de la SAGA (§2.5, §6.4)

Diseño: [ADR-0030](../adr/0030-prefect-auditoria-solo-lectura-por-apis.md). Instalación, reglas y configuración: [prefect/README.md](../../prefect/README.md). Prefect solo lee por las APIs de los servicios; no tiene credenciales de las tablas.

### 6.1 Contra el clúster `dev` de Floci

El repositorio no trae una configuración de Prefect para el clúster (limitación L-18): `prefect/config/local.toml` apunta a `pnpm dev` (puertos 4100–4103 y 4000) y `config/demo.toml` al stack del E2E. Para el clúster se abren `port-forward` a los cinco Services y se usa una copia de `local.toml` con esos puertos, **fuera del repositorio**:

```bash
S=infra/local/floci/.tmp/k8s-dev
k() { (set -a; source $S/kube-credentials.env; set +a; KUBECONFIG=$S/kubeconfig kubectl "$@"); }
k -n aegisvolt port-forward svc/saga-orchestrator-service   25100:80 &
k -n aegisvolt port-forward svc/station-reservation-service 25101:80 &
k -n aegisvolt port-forward svc/billing-wallet-service      25102:80 &
k -n aegisvolt port-forward svc/energy-dispatch-service     25103:80 &
k -n aegisvolt port-forward svc/graphql-api                 25104:80 &

sed -e 's/:4100"/:25100"/' -e 's/:4101"/:25101"/' -e 's/:4102"/:25102"/' -e 's/:4103"/:25103"/' \
    -e 's/:4000"/:25104"/' prefect/config/local.toml > /tmp/k8s-dev.toml   # solo cambia [environments.dev]

cd prefect
export PREFECT_HOME=$PWD/.prefect-home PREFECT_API_URL=http://127.0.0.1:4200/api
.venv/bin/prefect server start --host 127.0.0.1 --port 4200     # en otra terminal; dashboard http://127.0.0.1:4200
export AEGISVOLT_AUDIT_CONFIG=/tmp/k8s-dev.toml
.venv/bin/python -c "from aegisvolt_observability.flows import environment_health_monitor as f; f(environments=['dev','test','prod'])"
.venv/bin/python -c "from aegisvolt_observability.flows import saga_consistency_audit as f; f(environment='dev')"
```

Al terminar, detén los `port-forward` (`kill %1 %2 %3 %4 %5` en la misma shell) y el servidor de Prefect.

Resultado de la auditoría del 2026-11-19 (`infra/local/floci/.tmp/audit-20261119/24-prefect-live.log` y `25-prefect-saga-audit.log`):

- `environment_health_monitor`: `dev` **OPERATIONAL** (5 unidades listas y log groups presentes); `test` y `prod` **DOWN**, porque localmente solo `dev` tiene clúster (L-11). Es el estado real, no un fallo de Prefect. Publicó 18 métricas en `AegisVolt/Audit`.
- `saga_consistency_audit` de `dev`: 3 SAGAs revisadas (2 COMPLETED, 1 COMPENSATED), **0 hallazgos**, 7 métricas publicadas.

### 6.2 Si el servidor de Prefect falla con `database is locked`

Ocurre con el servidor efímero que Prefect arranca solo cuando no hay `PREFECT_API_URL`. Arranca un servidor dedicado (`prefect server start`) con su propio `PREFECT_HOME`, como arriba, y exporta `PREFECT_API_URL` antes de ejecutar los flows.

