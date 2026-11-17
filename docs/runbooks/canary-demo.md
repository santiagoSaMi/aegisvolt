# Runbook: canary de graphql-api (Argo Rollouts + Traefik + CloudWatch de Floci)

Diseño y umbrales: [ADR-0032](../adr/0032-canary-argo-rollouts-traefik-cloudwatch.md). Limitaciones: [L-04](../limitations.md#l-04--canary-con-métricas-de-cloudwatch) y [L-10](../limitations.md#l-10--el-clúster-k3s-de-floci-no-arranca-si-su-contenedor-cambia-de-ip).

## Qué se demuestra

1. **Dos versiones identificables.** Cada respuesta de graphql-api trae `x-service-version: <etiqueta inmutable>`, y cada log `graphql_operation` trae `version`.
2. **Reparto real del tráfico.**
   - Argo reescribe los pesos del `TraefikService graphql-api-split`, y Traefik reparte cada petición por *weighted round robin*.
   - El porcentaje se **mide en las respuestas** que recibe un cliente a través de Traefik; no se deduce del número de pods.
3. **Análisis con umbrales explícitos:**
   - disponibilidad: `/health/ready` del canary, al menos 11 de 12 sondeos;
   - tasa de error del servidor: ≤ 2 % con al menos 30 operaciones en 3 min, leída de CloudWatch.
4. **Desenlaces:**
   - promoción gradual (20 % → 50 % → 100 %) si el análisis pasa;
   - abort con el 100 % del tráfico devuelto a la versión estable si falla.

## Requisitos

- Floci en marcha y el clúster desplegado con `scripts/floci/k8s-deploy.sh dev`. El despliegue instala Argo Rollouts v1.10.1 y Traefik v3.7.16 (`infra/k8s/platform`) y deja el Rollout en `Healthy`.
- Los metric filters `GraphqlOperations` y `GraphqlServerErrors` aplicados en el workspace del ambiente: `scripts/floci/terraform-live.sh <env> apply`.

## Ejecutar

```bash
scripts/floci/canary-demo.sh dev success   # versión sana → promoción
scripts/floci/canary-demo.sh dev failure   # versión mal configurada → abort → se restaura la plantilla estable
```

Qué hace el script:

1. Construye una imagen nueva de graphql-api con una etiqueta nueva y la sube al ECR de Floci.
2. Abre `port-forward` a `svc/traefik` e inicia sesión en Cognito a través de Traefik (ruta `/` → web → Floci).
3. Genera tráfico continuo (~5 peticiones/s): la query autenticada `stations(city: "medellin")` (graphql-api → station-reservation). Registra en `traffic.log` la versión de la cabecera, el código HTTP y si hubo `errors`.
4. Publica la versión nueva:
   - parchea la imagen y la etiqueta `version` de la plantilla del Deployment, y la etiqueta del Rollout (argumento del análisis);
   - en `failure`, añade además `STATION_RESERVATION_URL=http://station-reservation-service:81`, un puerto inexistente: un error de configuración real.
5. Cada 5 s registra en `timeline.tsv` la fase, el paso, los **pesos reales del `TraefikService`** y los AnalysisRuns. Sigue midiendo 30 s después del desenlace.
6. Tras un abort, restaura la plantilla estable (imagen, etiqueta y quita la variable). El Rollout vuelve a `Healthy` sin crear otro canary.
7. Escribe `report.md`: el tráfico medido por tramo de peso y las mediciones de los AnalysisRuns.

Evidencias en `infra/local/floci/.tmp/k8s-<env>/canary-<escenario>-<fecha>/`: `traffic.log`, `timeline.tsv`, `events.log`, `analysisruns.json`, `rollout.yaml`, `traefikservice.yaml` y `report.md`.

## Inspección manual

Sin el plugin `kubectl-argo-rollouts` (no instalado, L-04):

```bash
S=infra/local/floci/.tmp/k8s-dev
k() { (set -a; source $S/kube-credentials.env; set +a; KUBECONFIG=$S/kubeconfig kubectl "$@"); }
k -n aegisvolt get rollout graphql-api -o jsonpath='{.status.phase} paso={.status.currentStepIndex} stable={.status.stableRS} canary={.status.currentPodHash}{"\n"}'
k -n aegisvolt get traefikservice graphql-api-split -o jsonpath='{.spec.weighted.services}{"\n"}'   # pesos reales
k -n aegisvolt get analysisrun                                                                     # Running/Successful/Failed/Inconclusive
k -n aegisvolt get analysisrun <nombre> -o jsonpath='{.status.metricResults}' | jq                 # cada medición
k -n aegisvolt get svc graphql-api graphql-api-canary -o wide                                      # selectores por rollouts-pod-template-hash

# Tráfico a través de Traefik (la versión que atendió cada respuesta):
k -n traefik port-forward svc/traefik 18090:80 &
curl -s -D - -o /dev/null http://127.0.0.1:18090/graphql -H 'content-type: application/json' \
  -d '{"query":"{__typename}"}' | grep -i x-service-version

# Operaciones manuales (equivalentes a `kubectl argo rollouts abort|promote`):
k -n aegisvolt patch rollout graphql-api --subresource status --type merge -p '{"status":{"abort":true}}'   # abortar
k -n aegisvolt patch rollout graphql-api --type merge -p '{"status":{"pauseConditions":null}}' --subresource status  # reanudar tras una pausa (p. ej. Inconclusive)

# Métricas que lee el análisis:
aws cloudwatch get-metric-statistics --namespace AegisVolt/dev --metric-name GraphqlServerErrors \
  --dimensions Name=ServiceName,Value=graphql-api Name=Version,Value=<etiqueta> \
  --statistics Sum --start-time <t0> --end-time <t1> --period 60
```

> **La consola web por `port-forward svc/web` no pasa por el canary.** Su nginx envía `/graphql` al Service estable `graphql-api`. Para que el navegador participe del reparto, entra por Traefik: `port-forward -n traefik svc/traefik 8080:80`, que enruta `/` a la web y `/graphql` al split. En AWS la entrada pública es Traefik detrás del NLB.

## Evidencia (dev, Floci 2.4.0, k3s v1.36.0+k3s1, 2026-11-15)

Versiones:

- v1 `sha-ec6d3a4d4b81-dirty-20261115202746`: estable inicial;
- v2 `sha-ec6d3a4d4b81-dirty-20261115203329`: canary sano;
- v3 `sha-ec6d3a4d4b81-dirty-20261115204018`: canary mal configurado.

Las etiquetas son `-dirty-` porque el árbol tenía cambios sin commit. En CI serán `sha-<commit>`.

### 1. Promoción (`success`, v1 → v2)

Distribución **medida** en las respuestas (`x-service-version`), por tramo de pesos del TraefikService:

| Pesos TraefikService (estable/canary) | Paso | Respuestas | Estable | Canary | Errores canary |
| --- | --- | --- | --- | --- | --- |
| antes de publicar | — | 65 | 100.0 % | 0.0 % | — |
| 100/0 | 0 (Progressing) | 51 | 86.3 % | 13.7 % | 0 |
| **80/20** | 1 (Progressing) | 760 | **78.2 %** | **21.8 %** | 0 |
| **50/50** | 3 (Progressing) | 668 | **47.0 %** | **53.0 %** | 0 |
| 100/0 (v2 ya es estable) | 4 (Healthy) | 304 | 0.0 % (v1) | **100.0 %** (v2) | 0 |

- La fila "100/0, paso 0" con 13,7 % de canary es un **efecto de borde del muestreo**. Los pesos se leen cada 5 s, y Argo pasó a 80/20 entre dos lecturas. Las respuestas de ese intervalo quedan en el tramo anterior.
- Con 760 y 668 respuestas, las desviaciones (+1,8 y +3,0 puntos) son compatibles con un WRR por petición y con la variación en latencia de cada versión.

AnalysisRuns (los dos `Successful`):

| AnalysisRun | Métrica | Mediciones |
| --- | --- | --- |
| `graphql-api-5b6fdb7f6b-2-1` (al 20 %) | availability | `ready` en todos los sondeos (Argo conserva las 10 últimas) |
| | error-rate | 4 × Successful. Operaciones por minuto `[6 51]`, `[6 61 21]`, `[6 61 51]`, `[6 61 61 20]`, errores `[]` (0 %) |
| `graphql-api-5b6fdb7f6b-2-3` (al 50 %) | availability | `ready` en todos los sondeos |
| | error-rate | 4 × Successful. Operaciones `[39 61 119 51]`, `[9 61 119 121]`, `[39 119 141 40]`, `[9 119 141 95]`, errores `[]` |

- Cada medición tuvo entre 57 y 270 operaciones del canary en la ventana, por encima del mínimo de 30.
- Resultado: `Healthy` con `stableRS` igual al hash de v2. La versión anterior se escaló a cero tras 30 s.

### 2. Rollback inducido (`failure`, v2 estable → v3 con `STATION_RESERVATION_URL` en un puerto inexistente)

| Pesos TraefikService (estable/canary) | Paso | Respuestas | Estable | Canary | Errores canary |
| --- | --- | --- | --- | --- | --- |
| antes de publicar | — | 74 | 100.0 % | 0.0 % | — |
| 100/0 | 0 (Progressing) | 42 | 90.5 % | 9.5 % | 4 |
| **80/20** | 1 (Progressing) | 239 | **82.4 %** | **17.6 %** | 42 |
| **100/0 tras el abort** | 0 (Degraded) | 263 | **100.0 %** | **0.0 %** | 0 |

AnalysisRun `graphql-api-b54848c59-3-1`: **Failed**.

- `availability`: Successful. El canary seguía `ready`, porque su readiness no incluye los servicios internos (ADR-0032).
- `error-rate`: Failed, Failed. Operaciones `[10 20]` y errores `[10 20]`, es decir 100 %. Después la medición `[10 29 5]` / `[10 29 5]`.
- Mensaje de Argo: `Metric "error-rate" assessed Failed due to failed (2) > failureLimit (1)`.
- Argo abortó: los pesos volvieron a **100/0** y el canary se escaló a cero. Las 263 respuestas posteriores las atendió v2.

Comprobaciones cruzadas:

- CloudWatch Logs `/aegisvolt/dev/graphql-api`: 46 operaciones de v3, **todas `server_error` con `["SERVICE_UNAVAILABLE"]`**. Coinciden con los 4 + 42 errores que vio el cliente.
- Métrica `GraphqlServerErrors{Version=v3}`: `Sum = 46`.
- Estado final tras la restauración: Rollout `Healthy`, `stableRS = currentPodHash` (v2), pesos 100/0, un solo pod y la plantilla sin `STATION_RESERVATION_URL`.

### Qué ocurre con una muestra insuficiente

Si en la ventana hay menos de 30 operaciones del canary (por ejemplo, sin tráfico):

- ninguna condición se cumple y la medición es **Inconclusive**;
- Argo **pausa** el Rollout: no promueve ni aborta;
- un operador lo reanuda (cuando hay tráfico) o lo aborta con los comandos de arriba.

**Verificado** (2026-11-15, 20:44 UTC):

- Se publicó v1 como canary sobre v2 estable, **sin generar tráfico**.
- AnalysisRun `graphql-api-75f8544c98-5-1`:
  - `availability` Successful (7 × `ready`);
  - `error-rate` → `[[] []]` → **Inconclusive**;
  - mensaje: `Metric "error-rate" assessed Inconclusive due to inconclusive (1) > inconclusiveLimit (0)`.
- Rollout `Paused` (`InconclusiveAnalysisRun`) en el paso 1 con pesos **80/20**: no promovió.
- Después se ejecutó el abort manual de arriba (`status.abort=true`): pesos 100/0 y fase `Degraded`. Al restaurar la plantilla de v2, el Rollout volvió a `Healthy`.

## Problemas conocidos

- **El clúster no arranca tras reiniciar Docker:** ver L-10 (IP del nodo).
- **El Rollout queda `Degraded` tras un abort** hasta que la plantilla vuelve a la versión estable o se publica una versión corregida (paso 6 del script). Es el comportamiento esperado de Argo.
- **El canary queda en `Paused`** (Inconclusive): falta de tráfico o la métrica todavía no llega a CloudWatch. Revisa `aws logs filter-log-events --log-group-name /aegisvolt/dev/graphql-api --filter-pattern '{ $.event = "graphql_operation" }'`.
