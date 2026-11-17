#!/usr/bin/env bash
# Verifica la operación de AegisVolt desplegado en el clúster EKS (k3s) de Floci.
#
# Uso: scripts/floci/k8s-verify.sh <dev|test|prod>      (tras scripts/floci/k8s-deploy.sh)
#
# Comprueba con el clúster real:
#   1. NetworkPolicies aplicadas (conexiones permitidas y denegadas entre pods);
#   2. seguridad de los pods (no root, sistema de archivos de solo lectura);
#   3. una SAGA real por la web (port-forward → nginx → graphql-api → servicios → Floci);
#   4. logs de los servicios en CloudWatch (/aegisvolt/<env>/<servicio>) vía Fluent Bit,
#      con el mismo correlation_id, y la métrica SagaCompleted.
# Imprime una tabla Markdown y la guarda en infra/local/floci/.tmp/k8s-<env>/verify.md.
source "$(dirname "$0")/lib.sh"

ENV="${1:-}"
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || die "Uso: $0 <dev|test|prod>"
require_cmd kubectl
require_cmd jq
load_aws_local_env
STATE="${FLOCI_TMP_DIR}/k8s-${ENV}"
[[ -f "${STATE}/kubeconfig" ]] || die "Primero: scripts/floci/k8s-deploy.sh ${ENV}"
# shellcheck source=/dev/null
source "${FLOCI_TMP_DIR}/identity-${ENV}.env"
k() { (set -a; source "${STATE}/kube-credentials.env"; set +a; KUBECONFIG="${STATE}/kubeconfig" kubectl "$@"); }

ROWS=(); FAILED=0
record() { ROWS+=("| $1 | $([[ $2 == ok ]] && echo sí || echo no) | $3 |")
  if [[ $2 == ok ]]; then log_ok "$1: $3"; else log_error "$1: $3"; FAILED=1; fi; }
pod_of() { k -n aegisvolt get pod -l "app.kubernetes.io/name=$1" -o jsonpath='{.items[0].metadata.name}'; }
# Conexión HTTP desde un pod (busybox wget de alpine); 0 = respondió.
reach() { k -n aegisvolt exec "$(pod_of "$1")" -- wget -q -T 3 -O /dev/null "http://$2/${3:-health/live}" >/dev/null 2>&1; }

# --- 1. NetworkPolicies ----------------------------------------------------------------------
check_allowed() { if reach "$1" "$2" "${3:-}"; then record "Red: $1 → $2" ok "permitido (política)"; else record "Red: $1 → $2" fail "bloqueado y debía estar permitido"; fi; }
check_denied() { if reach "$1" "$2" "${3:-}"; then record "Red: $1 → $2" fail "permitido y debía estar bloqueado"; else record "Red: $1 → $2" ok "bloqueado (default-deny)"; fi; }
check_allowed graphql-api billing-wallet-service
check_allowed saga-orchestrator-service station-reservation-service
check_allowed web graphql-api
check_denied billing-wallet-service station-reservation-service
check_denied web billing-wallet-service
check_denied station-reservation-service saga-orchestrator-service

# --- 2. Seguridad de los pods ---------------------------------------------------------------
for app in billing-wallet-service web; do
  out="$(k -n aegisvolt exec "$(pod_of "$app")" -- sh -c 'id -u; touch /probe 2>&1 || true' 2>&1)"
  uid="$(echo "$out" | head -1)"
  if [[ "$uid" != 0 && "$out" == *"Read-only file system"* ]]; then
    record "Seguridad: ${app}" ok "uid ${uid}, sistema de archivos de solo lectura"
  else
    record "Seguridad: ${app}" fail "$(echo "$out" | tr '\n' ' ')"
  fi
done
psa="$(k get ns aegisvolt -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')"
[[ "$psa" == restricted ]] && record "Pod Security Admission" ok "namespace aegisvolt en restricted" || record "Pod Security Admission" fail "enforce=${psa}"

# --- 3. SAGA real por la web --------------------------------------------------------------------
k -n aegisvolt port-forward svc/web 18080:80 >/dev/null 2>&1 &
PF_WEB=$!
k -n aegisvolt port-forward svc/station-reservation-service 18101:80 >/dev/null 2>&1 &
PF_ST=$!
k -n aegisvolt port-forward svc/billing-wallet-service 18102:80 >/dev/null 2>&1 &
PF_BW=$!
trap 'kill $PF_WEB $PF_ST $PF_BW 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:18080/healthz 2>/dev/null && curl -fsS -o /dev/null http://127.0.0.1:18102/health/live 2>/dev/null && break; sleep 1; done
# Datos de demostración por las APIs de los servicios (operador: port-forward). Una
# estación por ejecución: la SAGA deja el conector OCCUPIED (carga activa) y una estación
# fija se quedaría sin conectores libres tras dos verificaciones.
STATION="st_k8s-$(date +%s)"
curl -fsS -o /dev/null -X PUT "http://127.0.0.1:18101/v1/stations/${STATION}" -H 'content-type: application/json' \
  -d '{"name":"Estación K8s","city":"medellin","location":{"latitude":6.2,"longitude":-75.5},"connectors":[{"connectorId":"cn_01","type":"CCS2","maxPowerKw":60},{"connectorId":"cn_02","type":"CCS2","maxPowerKw":60}]}' || true
curl -fsS -o /dev/null -X PUT "http://127.0.0.1:18102/v1/wallets/${DEMO_FLEET}" -H 'content-type: application/json' -d '{}' || true
curl -fsS -o /dev/null -X PUT "http://127.0.0.1:18102/v1/wallets/${DEMO_FLEET}/top-ups/tup_k8s-$(date +%s)" -H 'content-type: application/json' \
  -d '{"amount":{"amountMinor":50000000,"currency":"COP"}}'
TOKEN="$(curl -fsS http://127.0.0.1:18080/auth/cognito -H 'content-type: application/x-amz-json-1.1' \
  -H 'x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth' \
  -d "{\"AuthFlow\":\"USER_PASSWORD_AUTH\",\"ClientId\":\"${COGNITO_CLIENT_ID}\",\"AuthParameters\":{\"USERNAME\":\"operador\",\"PASSWORD\":\"${DEMO_PASSWORD}\"}}" \
  | jq -r .AuthenticationResult.IdToken)"
CORR="$(cat /proc/sys/kernel/random/uuid)"
STARTED_AT="$(date -u -d '-1 min' +%FT%TZ)"
CONNECTOR="$(curl -fsS http://127.0.0.1:18080/graphql -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" \
  -d "{\"query\":\"{ availableConnectors(stationId: \\\"${STATION}\\\") { connector { connectorId } } }\"}" | jq -r '.data.availableConnectors[0].connector.connectorId')"
RESULT="$(curl -fsS http://127.0.0.1:18080/graphql -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" -H "x-correlation-id: ${CORR}" \
  -d "{\"query\":\"mutation { reserveAndActivateCharging(input:{idempotencyKey:\\\"$(cat /proc/sys/kernel/random/uuid)\\\", stationId:\\\"${STATION}\\\", connectorId:\\\"${CONNECTOR}\\\", requestedEnergyKwh: 10}) { saga { status sagaId } } }\"}")"
STATUS="$(echo "$RESULT" | jq -r '.data.reserveAndActivateCharging.saga.status')"
[[ "$STATUS" == COMPLETED ]] && record "SAGA por la web" ok "COMPLETED (correlation_id ${CORR})" || record "SAGA por la web" fail "$RESULT"

# --- 4. Logs reales en CloudWatch (Fluent Bit) y métrica ----------------------------------------
SERVICES=(web graphql-api saga-orchestrator-service station-reservation-service billing-wallet-service energy-dispatch-service)
for _ in $(seq 1 24); do
  missing=0
  for s in "${SERVICES[@]}"; do
    n="$(aws logs filter-log-events --log-group-name "/aegisvolt/${ENV}/${s}" --filter-pattern "\"${CORR}\"" --query 'length(events)' --output text 2>/dev/null || echo 0)"
    [[ "$n" =~ ^[1-9] ]] || missing=1
  done
  (( missing == 0 )) && break
  sleep 5
done
for s in "${SERVICES[@]}"; do
  ev="$(aws logs filter-log-events --log-group-name "/aegisvolt/${ENV}/${s}" --filter-pattern "\"${CORR}\"" --output json)"
  n="$(jq '.events | length' <<<"$ev")"
  stream="$(jq -r '.events[0].logStreamName // "-"' <<<"$ev")"
  if [[ "$n" -ge 1 ]] && jq -e '.events[0].message | fromjson | .service_name and .operation and .correlation_id' <<<"$ev" >/dev/null 2>&1; then
    record "CloudWatch /aegisvolt/${ENV}/${s}" ok "${n} eventos JSON, stream ${stream}"
  else
    record "CloudWatch /aegisvolt/${ENV}/${s}" fail "eventos=${n}"
  fi
done
sleep 3
value="$(aws cloudwatch get-metric-statistics --namespace "AegisVolt/${ENV}" --metric-name SagaCompleted --statistics Sum \
  --start-time "$STARTED_AT" --end-time "$(date -u -d '+5 min' +%FT%TZ)" --period 3600 --query 'Datapoints[0].Sum' --output text)"
[[ "$value" =~ ^[1-9] ]] && record "Métrica AegisVolt/${ENV} SagaCompleted" ok "Sum=${value} (metric filter sobre los logs reales)" \
  || record "Métrica AegisVolt/${ENV} SagaCompleted" fail "Sum=${value}"

{
  echo "# Verificación en el clúster aegisvolt-${ENV} (Floci) — $(date -u +%FT%TZ)"
  echo
  echo "| Verificación | ¿Cumple? | Evidencia |"
  echo "| --- | --- | --- |"
  printf '%s\n' "${ROWS[@]}"
} | tee "${STATE}/verify.md"
exit "$FAILED"
