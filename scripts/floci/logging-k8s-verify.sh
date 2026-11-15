#!/usr/bin/env bash
# Verificación de punta a punta de la recolección de logs desde Kubernetes
# (ADR-0029) contra Floci:
#   pods (k3s de Floci) → Fluent Bit DaemonSet → CloudWatch Logs de Floci
#   → log groups /aegisvolt/<env>/<servicio> (Terraform) → metric filters → métricas y alarma.
#
# Uso: scripts/floci/logging-k8s-verify.sh [--env dev|test|prod] [--keep]
#
# Requisitos: Floci en marcha y `scripts/floci/terraform-live.sh <env> apply` hecho.
# Crea un clúster EKS temporal (aegisvolt-logcheck-<id>) y lo elimina al terminar,
# junto con su volumen y el usuario IAM emitido para kubectl (salvo --keep).
# Los pods emisores escriben líneas con el esquema de logs de ADR-0028; las
# aplicaciones reales se despliegan en la fase de K8s.
source "$(dirname "$0")/lib.sh"

ENV=dev
KEEP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) shift; ENV="${1:?--env requiere dev|test|prod}" ;;
    --keep) KEEP=true ;;
    *) die "Opción desconocida: $1" ;;
  esac
  shift
done
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || die "--env debe ser dev, test o prod"

require_docker
require_cmd aws
require_cmd jq
require_cmd kubectl
load_aws_local_env
curl -fsS "$FLOCI_HEALTH_URL" >/dev/null || die "Floci no responde en ${FLOCI_ENDPOINT}"
FLOCI_VERSION="$(curl -fsS "$FLOCI_HEALTH_URL" | jq -r .version)"

GROUP_PREFIX="/aegisvolt/${ENV}"
NS_METRICS="AegisVolt/${ENV}"
SERVICES=(station-reservation-service billing-wallet-service energy-dispatch-service saga-orchestrator-service graphql-api)
for s in "${SERVICES[@]}" unclassified; do
  aws logs describe-log-groups --log-group-name-prefix "${GROUP_PREFIX}/${s}" --query 'logGroups[0].logGroupName' --output text | grep -qx "${GROUP_PREFIX}/${s}" \
    || die "Falta el log group ${GROUP_PREFIX}/${s}: ejecute scripts/floci/terraform-live.sh ${ENV} apply"
done

RUN_ID="$(date +%s)"
CLUSTER="aegisvolt-logcheck-${RUN_ID}"
WORK="${FLOCI_TMP_DIR}/logcheck-${RUN_ID}"
mkdir -p "$WORK/lines"
REPORT="${FLOCI_TMP_DIR}/logging-k8s-verify-${RUN_ID}.md"
CORR="$(cat /proc/sys/kernel/random/uuid)"
SAGA="saga_$(cat /proc/sys/kernel/random/uuid)"
STARTED_AT="$(date -u +%FT%TZ)"
ROWS=()
FAILED=0
CLEANUP=()

record() { # <verificación> <ok|fail> <evidencia>
  ROWS+=("| $1 | $([[ $2 == ok ]] && echo sí || echo no) | $3 |")
  if [[ "$2" == ok ]]; then log_ok "$1: $3"; else log_error "$1: $3"; FAILED=1; fi
}
on_cleanup() { CLEANUP+=("$1"); }
cleanup() {
  if [[ "$KEEP" == true ]]; then
    log_warn "--keep: clúster ${CLUSTER} conservado (kubeconfig: ${WORK}/kubeconfig)"
    return
  fi
  for (( i=${#CLEANUP[@]}-1; i>=0; i-- )); do eval "${CLEANUP[$i]}" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

# --------------------------------------------------------------- clúster EKS (k3s)
log_info "Floci ${FLOCI_VERSION} · ambiente ${ENV} · clúster ${CLUSTER}"
ROLE="$(aws iam create-role --role-name "${CLUSTER}-role" --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"eks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  --query Role.Arn --output text)"
on_cleanup "aws iam delete-role --role-name '${CLUSTER}-role'"
SUBNETS="$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')"
aws eks create-cluster --name "$CLUSTER" --kubernetes-version 1.36 --role-arn "$ROLE" \
  --resources-vpc-config "subnetIds=${SUBNETS}" >/dev/null
# En modo persistent, delete-cluster no elimina el contenedor ni el volumen de k3s.
on_cleanup "aws eks delete-cluster --name '${CLUSTER}'; for i in \$(seq 1 30); do aws eks describe-cluster --name '${CLUSTER}' >/dev/null 2>&1 || break; sleep 2; done; docker rm -f 'floci-aws-eks-${CLUSTER}'; docker volume rm 'floci-aws-eks-${CLUSTER}'"
for _ in $(seq 1 60); do
  STATUS="$(aws eks describe-cluster --name "$CLUSTER" --query cluster.status --output text)"
  [[ "$STATUS" == ACTIVE ]] && break; sleep 5
done
[[ "$STATUS" == ACTIVE ]] || die "Clúster en estado ${STATUS}"

# test/test es rechazado por el webhook IAM de Floci: access key emitida por Floci.
aws iam create-user --user-name "${CLUSTER}-kube" >/dev/null
read -r AK SK < <(aws iam create-access-key --user-name "${CLUSTER}-kube" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
on_cleanup "aws iam delete-user --user-name '${CLUSTER}-kube'"
on_cleanup "aws iam delete-access-key --user-name '${CLUSTER}-kube' --access-key-id '${AK}'"
AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" aws eks update-kubeconfig --name "$CLUSTER" --kubeconfig "$WORK/kubeconfig" >/dev/null
k() { AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" KUBECONFIG="$WORK/kubeconfig" kubectl "$@"; }
for _ in $(seq 1 60); do k get serviceaccount default >/dev/null 2>&1 && break; sleep 2; done
K3S_VERSION="$(k version -o json | jq -r .serverVersion.gitVersion)"
record "Clúster EKS de Floci" ok "ACTIVE, ${K3S_VERSION}"

# --------------------------------------------------------------- Fluent Bit
FLOCI_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "aegisvolt-floci").IPAddress}}' "$FLOCI_CONTAINER")"
[[ -n "$FLOCI_IP" ]] || die "No se obtuvo la IP de Floci en la red aegisvolt-floci"
FLOCI_CA="${FLOCI_DATA_DIR}/tls/floci-root-ca.crt"
[[ -f "$FLOCI_CA" ]] || die "Falta ${FLOCI_CA}: Floci debe correr con FLOCI_TLS_ENABLED=true (config/floci.env)"
kubectl kustomize "${REPO_ROOT}/infra/k8s/overlays/${ENV}" | sed "s/FLOCI_IP/${FLOCI_IP}/" > "$WORK/logging.yaml"
k apply -f "$WORK/logging.yaml" >/dev/null 2>&1 || true   # crea el namespace (el DaemonSet espera a floci-ca)
# CA copiada del volumen de datos (fuera de banda), no descargada por HTTP.
k -n logging create configmap floci-ca --from-file=floci-root-ca.crt="$FLOCI_CA" --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f "$WORK/logging.yaml" >/dev/null
if k -n logging rollout status ds/fluent-bit --timeout=300s >/dev/null 2>&1; then
  record "DaemonSet fluent-bit (overlay ${ENV} + componente floci)" ok "listo; HTTPS a Floci (${FLOCI_IP}:4566) vía Service sin selector, CA verificada"
else
  record "DaemonSet fluent-bit" fail "no quedó listo"
  k -n logging get pods -o wide >&2; k -n logging logs ds/fluent-bit --tail=40 >&2 || true
  exit 1
fi

# --------------------------------------------------------------- pods emisores
line() { # <servicio> <nivel> <mensaje> <json-extra>
  jq -cn --arg s "$1" --arg l "$2" --arg m "$3" --arg e "$ENV" --arg c "$CORR" --arg g "$SAGA" --argjson x "$4" \
    '{level:$l,timestamp:(now|todate),service_name:$s,environment:$e,version:"logcheck",correlation_id:$c,saga_id:$g,operation:null} + $x + {message:$m}'
}
saga_event() { # <evento> <estado> <nivel> <json-extra>
  line saga-orchestrator-service "$3" "Evento de la SAGA" \
    "$(jq -cn --arg e "$1" --arg st "$2" --argjson x "$4" '{component:"saga",operation:"ReserveAndActivateCharging",event:$e,saga_status:$st} + $x')"
}
{
  saga_event STEP_FAILED COMPENSATING warn '{"step":"ACTIVATION","error":{"type":"SagaStepFailure","code":"CHARGER_HARDWARE_FAULT","message":"Paso ACTIVATION fallido"}}'
  saga_event SAGA_COMPENSATED COMPENSATED warn '{"duration_ms":900}'
  saga_event SAGA_COMPLETED COMPLETED info '{"duration_ms":1200}'
  saga_event SAGA_FAILED FAILED warn '{"duration_ms":300}'
  saga_event SAGA_COMPENSATION_FAILED COMPENSATION_FAILED error '{"duration_ms":5000,"error":{"type":"SagaCompensationFailure","code":"SERVICE_UNAVAILABLE","message":"Compensación fallida"}}'
} > "$WORK/lines/saga-orchestrator-service.log"
{
  line billing-wallet-service info "Petición HTTP" '{"operation":"RefundWallet","event":"http_request","method":"POST","http_status":200,"duration_ms":10.6}'
  line billing-wallet-service error "Error no controlado" '{"operation":"DebitWallet","http_status":500,"problem_code":"INTERNAL_ERROR","error":{"type":"TypeError","message":"x is undefined"}}'
  line billing-wallet-service error "Petición HTTP fallida" '{"operation":"DebitWallet","event":"http_request","method":"PUT","http_status":500,"duration_ms":4.2}'
} > "$WORK/lines/billing-wallet-service.log"
line station-reservation-service info "Petición HTTP" '{"operation":"ReleaseReservation","event":"http_request","method":"POST","http_status":200,"duration_ms":7.1}' > "$WORK/lines/station-reservation-service.log"
line energy-dispatch-service warn "Falla de hardware del cargador (simulada)" '{"operation":"StartChargingSession","event":"charger_fault","fault_code":"E-HW-001","error":{"type":"ChargerHardwareFault","code":"E-HW-001","message":"Falla física del cargador (simulada)"}}' > "$WORK/lines/energy-dispatch-service.log"
line graphql-api info "Petición HTTP" '{"operation":"mutation.ReserveAndActivateCharging","event":"http_request","method":"POST","http_status":200,"duration_ms":950}' > "$WORK/lines/graphql-api.log"
line unknown-service info "Pod de AegisVolt sin etiqueta de servicio" '{"marker":"fallback"}' > "$WORK/lines/unlabeled.log"
echo "{\"marker\":\"foreign-${RUN_ID}\",\"correlation_id\":\"${CORR}\",\"message\":\"pod ajeno a AegisVolt\"}" > "$WORK/lines/foreign.log"

k create namespace logcheck >/dev/null
k -n logcheck create configmap lines --from-file="$WORK/lines" >/dev/null
emitter() { # <pod> <archivo> <etiquetas>
  k -n logcheck run "$1" --image=busybox:1.37 --restart=Never --labels="$3" \
    --overrides='{"spec":{"containers":[{"name":"'"$1"'","image":"busybox:1.37","command":["sh","-c","sleep 5; cat /lines/'"$2"'; sleep 3600"],"volumeMounts":[{"name":"lines","mountPath":"/lines"}]}],"volumes":[{"name":"lines","configMap":{"name":"lines"}}]}}' >/dev/null
}
for s in "${SERVICES[@]}"; do
  emitter "${s}-0" "${s}.log" "app.kubernetes.io/name=${s},app.kubernetes.io/part-of=aegisvolt"
done
emitter unlabeled-0 unlabeled.log "app.kubernetes.io/part-of=aegisvolt"
emitter foreign-0 foreign.log "app=foreign"
k -n logcheck wait --for=condition=Ready pod --all --timeout=240s >/dev/null || die "Los pods emisores no arrancaron"

# --------------------------------------------------------------- logs en Floci
events_of() { # <grupo> → JSON de eventos con el correlation_id de esta ejecución
  aws logs filter-log-events --log-group-name "$1" --start-time "$(( RUN_ID * 1000 - 60000 ))" \
    --filter-pattern "\"${CORR}\"" --output json 2>/dev/null || echo '{"events":[]}'
}
for _ in $(seq 1 30); do
  pending=0
  for s in "${SERVICES[@]}"; do
    want="$(wc -l < "$WORK/lines/${s}.log")"
    got="$(events_of "${GROUP_PREFIX}/${s}" | jq '.events | length')"
    (( got >= want )) || pending=1
  done
  (( pending == 0 )) && break
  sleep 5
done

for s in "${SERVICES[@]}"; do
  ev="$(events_of "${GROUP_PREFIX}/${s}")"
  want="$(wc -l < "$WORK/lines/${s}.log")"
  got="$(jq '.events | length' <<<"$ev")"
  stream="$(jq -r '.events[0].logStreamName // "-"' <<<"$ev")"
  # log_key log: el mensaje en CloudWatch es EXACTAMENTE la línea JSON de la app.
  same="$(jq -r '[.events[].message] | sort | join("\n")' <<<"$ev" | diff -q - <(sort "$WORK/lines/${s}.log") >/dev/null && echo yes || echo no)"
  if [[ "$got" == "$want" && "$stream" == "${s}-0" && "$same" == yes ]]; then
    record "Logs de ${s}" ok "${got} eventos en ${GROUP_PREFIX}/${s}, stream ${stream}, JSON intacto"
  else
    record "Logs de ${s}" fail "eventos=${got}/${want}, stream=${stream}, JSON intacto=${same}"
  fi
done

fallback="$(aws logs filter-log-events --log-group-name "${GROUP_PREFIX}/unclassified" --start-time "$(( RUN_ID * 1000 - 60000 ))" --filter-pattern "\"${CORR}\"" --query 'length(events)' --output text)"
[[ "$fallback" == 1 ]] && record "Pod sin app.kubernetes.io/name → grupo de respaldo" ok "${GROUP_PREFIX}/unclassified" \
  || record "Grupo de respaldo" fail "eventos=${fallback}"

foreign=0
for s in "${SERVICES[@]}" unclassified; do
  n="$(aws logs filter-log-events --log-group-name "${GROUP_PREFIX}/${s}" --start-time "$(( RUN_ID * 1000 - 60000 ))" --filter-pattern "\"foreign-${RUN_ID}\"" --query 'length(events)' --output text)"
  foreign=$(( foreign + n ))
done
[[ "$foreign" == 0 ]] && record "Pod ajeno a AegisVolt (sin part-of=aegisvolt)" ok "descartado por el filtro grep" \
  || record "Pod ajeno a AegisVolt" fail "${foreign} eventos enviados"

# Traza por correlation_id en todos los servicios del ambiente (Logs Insights: fields/filter/sort).
GROUPS_ARGS=(); for s in "${SERVICES[@]}"; do GROUPS_ARGS+=("${GROUP_PREFIX}/${s}"); done
QID="$(aws logs start-query --log-group-names "${GROUPS_ARGS[@]}" --start-time $(( RUN_ID - 120 )) --end-time $(( $(date +%s) + 60 )) \
  --query-string "fields @timestamp, @log, operation, message | filter correlation_id = \"${CORR}\" | sort @timestamp asc" --query queryId --output text)"
for _ in $(seq 1 20); do
  read -r QS QN < <(aws logs get-query-results --query-id "$QID" --query '[status, length(results)]' --output text)
  [[ "$QS" == Complete || "$QS" == Failed ]] && break; sleep 1
done
EXPECTED_TRACE="$(cat "$WORK"/lines/{saga-orchestrator-service,billing-wallet-service,station-reservation-service,energy-dispatch-service,graphql-api}.log | wc -l)"
[[ "$QS" == Complete && "$QN" == "$EXPECTED_TRACE" ]] && record "Traza por correlation_id (Logs Insights, 5 grupos)" ok "${QN} líneas de 5 servicios" \
  || record "Traza por correlation_id" fail "estado=${QS} filas=${QN}/${EXPECTED_TRACE}"

# --------------------------------------------------------------- métricas (metric filters de Terraform)
metric() { # <nombre> <estadística> [dimensiones...] → valor agregado desde el inicio de la ejecución
  aws cloudwatch get-metric-statistics --namespace "$NS_METRICS" --metric-name "$1" --statistics "$2" \
    --start-time "$STARTED_AT" --end-time "$(date -u -d '+5 min' +%FT%TZ)" --period 3600 "${@:3}" \
    --query "Datapoints[0].$2" --output text
}
sleep 3
check_metric() { # <etiqueta> <esperado> <nombre> <estadística> [dimensiones...]
  local v; v="$(metric "${@:3}")"
  [[ "$v" == "$2" ]] && record "Métrica $1" ok "${NS_METRICS} ${3} ${4}=${v}" || record "Métrica $1" fail "${3} ${4}=${v} (esperado ${2})"
}
check_metric "SAGA completadas" 1.0 SagaCompleted Sum
check_metric "SAGA compensadas" 1.0 SagaCompensated Sum
check_metric "SAGA fallidas" 1.0 SagaFailed Sum
check_metric "SAGA con compensación fallida" 1.0 SagaCompensationFailed Sum
check_metric "duración de la SAGA" 1850.0 SagaDuration Average
check_metric "errores de billing-wallet-service" 2.0 ServiceErrors Sum --dimensions Name=ServiceName,Value=billing-wallet-service
check_metric "errores de saga-orchestrator-service" 1.0 ServiceErrors Sum --dimensions Name=ServiceName,Value=saga-orchestrator-service
check_metric "HTTP 5xx de billing-wallet-service" 1.0 Http5xx Sum --dimensions Name=ServiceName,Value=billing-wallet-service

ALARM="aegisvolt-${ENV}-saga-compensation-failed"
for _ in $(seq 1 36); do
  state="$(aws cloudwatch describe-alarms --alarm-names "$ALARM" --query 'MetricAlarms[0].StateValue' --output text)"
  [[ "$state" == ALARM ]] && break; sleep 5
done
[[ "$state" == ALARM ]] && record "Alarma ${ALARM}" ok "pasó a ALARM" || record "Alarma ${ALARM}" fail "estado=${state}"

{
  echo "# Recolección de logs desde Kubernetes — Floci ${FLOCI_VERSION}, ambiente ${ENV}, $(date -u +%FT%TZ)"
  echo
  echo "Fluent Bit $(k -n logging get ds fluent-bit -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/@.*//; s/.*://') · k3s ${K3S_VERSION} · correlation_id ${CORR}"
  echo
  echo "| Verificación | ¿Cumple? | Evidencia |"
  echo "| --- | --- | --- |"
  printf '%s\n' "${ROWS[@]}"
} | tee "$REPORT"
log_info "Informe: ${REPORT}"
exit "$FAILED"
