#!/usr/bin/env bash
# Comprueba qué operaciones de CloudWatch Logs y CloudWatch Metrics están
# REALMENTE implementadas en el Floci local (no lo que dice la documentación),
# incluido el comportamiento que necesita AegisVolt: metric filters con patrón
# JSON, valor desde un campo y dimensiones; Logs Insights; alarmas; EMF.
#
# Uso: scripts/floci/cloudwatch-probe.sh [--keep] [--alarm-wait <segundos>]
#   --keep        no limpia los recursos creados (inspección manual)
#   --alarm-wait  espera máxima para la evaluación de la alarma (por defecto 150)
#
# Crea recursos con el prefijo aegisvolt-probe-<id> y elimina SOLO esos. Las
# métricas no se pueden borrar en CloudWatch: van al namespace AegisVoltProbe/<id>.
# Imprime una tabla Markdown y la guarda en infra/local/floci/.tmp/.
source "$(dirname "$0")/lib.sh"

KEEP=false
ALARM_WAIT=150
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=true ;;
    --alarm-wait) shift; ALARM_WAIT="${1:?--alarm-wait requiere segundos}" ;;
    *) die "Opción desconocida: $1" ;;
  esac
  shift
done

require_cmd aws
require_cmd jq
load_aws_local_env
curl -fsS "$FLOCI_HEALTH_URL" >/dev/null || die "Floci no responde en ${FLOCI_ENDPOINT}"
FLOCI_VERSION="$(curl -fsS "$FLOCI_HEALTH_URL" | jq -r .version)"

RUN_ID="$(date +%s)-$$"
PREFIX="aegisvolt-probe-${RUN_ID}"
NS="AegisVoltProbe/${RUN_ID}"
GROUP_A="/${PREFIX}/dev/saga-orchestrator-service"
GROUP_B="/${PREFIX}/dev/billing-wallet-service"
STREAM="pod-1"
CORR="corr-${RUN_ID}"
mkdir -p "$FLOCI_TMP_DIR"
REPORT="${FLOCI_TMP_DIR}/cloudwatch-probe-${RUN_ID}.md"
ROWS=()

cleanup() {
  [[ "$KEEP" == true ]] && { log_warn "--keep: recursos con prefijo ${PREFIX} conservados"; return; }
  aws logs delete-log-group --log-group-name "$GROUP_A" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "$GROUP_B" >/dev/null 2>&1 || true
  aws cloudwatch delete-alarms --alarm-names "${PREFIX}-alarm" >/dev/null 2>&1 || true
  aws cloudwatch delete-dashboards --dashboard-names "${PREFIX}-dash" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# record <servicio> <operación> <resultado: sí|no|parcial> <detalle>
record() { ROWS+=("| $1 | $2 | $3 | $4 |"); case "$3" in sí) log_ok "$1 · $2: $4" ;; parcial) log_warn "$1 · $2: $4" ;; *) log_error "$1 · $2: $4" ;; esac; }

# try <var-salida> <comando...>: ejecuta y guarda stdout+stderr; devuelve el código.
try() {
  local __out=$1; shift
  local output status=0
  output="$("$@" 2>&1)" || status=$?
  printf -v "$__out" '%s' "$output"
  return "$status"
}

# Código de error de AWS en la salida del CLI (o el texto acortado).
err_of() { grep -o '(\w*)' <<<"$1" | head -n1 | tr -d '()' || true; }
short() { local e; e="$(err_of "$1")"; [[ -n "$e" ]] && echo "$e" || head -c 120 <<<"$1" | tr '\n' ' '; }

now_ms() { date +%s%3N; }

# Línea de log con el esquema de AegisVolt (ADR-0028).
log_line() { # <service> <event> <level> <extra-json>
  jq -cn --arg s "$1" --arg e "$2" --arg l "$3" --arg c "$CORR" --argjson x "$4" \
    '{timestamp:(now|todate),level:$l,service_name:$s,environment:"dev",correlation_id:$c,operation:"ReserveAndActivateCharging",event:$e,message:"probe"} + $x'
}

put_events() { # <group> <json-line>...
  local group=$1; shift
  local events ts
  ts="$(now_ms)"
  events="$(for line in "$@"; do jq -cn --arg m "$line" --argjson t "$ts" '{timestamp:$t,message:$m}'; done | jq -cs .)"
  aws logs put-log-events --log-group-name "$group" --log-stream-name "$STREAM" --log-events "$events"
}

log_info "Floci ${FLOCI_VERSION} en ${FLOCI_ENDPOINT} · prefijo ${PREFIX}"

# ---------------------------------------------------------------- Logs: base
if try out aws logs create-log-group --log-group-name "$GROUP_A" && aws logs create-log-group --log-group-name "$GROUP_B" >/dev/null; then
  record Logs CreateLogGroup sí "grupos /${PREFIX}/dev/<servicio>"
else record Logs CreateLogGroup no "$(short "$out")"; die "Sin log groups no se puede continuar"; fi

if try out aws logs put-retention-policy --log-group-name "$GROUP_A" --retention-in-days 7 \
  && [[ "$(aws logs describe-log-groups --log-group-name-prefix "$GROUP_A" --query 'logGroups[0].retentionInDays' --output text)" == 7 ]]; then
  record Logs "PutRetentionPolicy + DescribeLogGroups" sí "retención 7 días devuelta"
else record Logs PutRetentionPolicy no "$(short "$out")"; fi

ARN_A="$(aws logs describe-log-groups --log-group-name-prefix "$GROUP_A" --query 'logGroups[0].arn' --output text)"
if try out aws logs tag-resource --resource-arn "${ARN_A%:\*}" --tags Project=aegisvolt,Environment=dev \
  && [[ "$(aws logs list-tags-for-resource --resource-arn "${ARN_A%:\*}" --query 'tags.Environment' --output text)" == dev ]]; then
  record Logs "TagResource + ListTagsForResource" sí "etiquetas Project/Environment"
else record Logs TagResource no "$(short "$out")"; fi

if try out aws logs create-log-stream --log-group-name "$GROUP_A" --log-stream-name "$STREAM" \
  && aws logs create-log-stream --log-group-name "$GROUP_B" --log-stream-name "$STREAM" >/dev/null \
  && [[ "$(aws logs describe-log-streams --log-group-name "$GROUP_A" --query 'length(logStreams)' --output text)" == 1 ]]; then
  record Logs "CreateLogStream + DescribeLogStreams" sí "1 stream por grupo"
else record Logs CreateLogStream no "$(short "$out")"; fi

# ------------------------------------------------- Logs: metric filters (antes de los eventos)
mf() { # <nombre> <patrón> <transformación-json>
  aws logs put-metric-filter --log-group-name "$GROUP_A" --filter-name "$1" --filter-pattern "$2" \
    --metric-transformations "$3"
}
if try out mf SagaCompensated '{ $.event = "SAGA_COMPENSATED" }' \
  "metricName=SagaCompensated,metricNamespace=${NS},metricValue=1,unit=Count"; then
  record Logs "PutMetricFilter (patrón JSON, valor 1)" sí "{ \$.event = \"SAGA_COMPENSATED\" }"
else record Logs "PutMetricFilter (patrón JSON)" no "$(short "$out")"; fi

if try out mf SagaDuration '{ $.event = "SAGA_COMPLETED" }' \
  "metricName=SagaDuration,metricNamespace=${NS},metricValue=\$.duration_ms,unit=Milliseconds"; then
  record Logs "PutMetricFilter (valor desde \$.duration_ms)" sí "aceptado"
else record Logs "PutMetricFilter (valor desde campo)" no "$(short "$out")"; fi

DIM_TRANSFORM="$(jq -cn --arg ns "$NS" '[{metricName:"ServiceErrors",metricNamespace:$ns,metricValue:"1",unit:"Count",dimensions:{ServiceName:"$.service_name"}}]')"
if try out aws logs put-metric-filter --log-group-name "$GROUP_B" --filter-name ServiceErrors \
  --filter-pattern '{ ($.level = "error") || ($.level = "fatal") }' --metric-transformations "$DIM_TRANSFORM"; then
  record Logs "PutMetricFilter (dimensión desde \$.service_name, patrón con \|\|)" sí "aceptado"
else record Logs "PutMetricFilter (dimensiones)" no "$(short "$out")"; fi

if try out aws logs describe-metric-filters --log-group-name "$GROUP_A" --query 'length(metricFilters)' --output text && [[ "$out" == 2 ]]; then
  record Logs DescribeMetricFilters sí "2 filtros en el grupo"
else record Logs DescribeMetricFilters no "$(short "$out")"; fi

SAMPLE="$(log_line saga-orchestrator-service SAGA_COMPENSATED warn '{}')"
if try out aws logs test-metric-filter --filter-pattern '{ $.event = "SAGA_COMPENSATED" }' --log-event-messages "$SAMPLE" '{"event":"OTHER"}' \
  && [[ "$(jq '.matches | length' <<<"$out")" == 1 ]]; then
  record Logs TestMetricFilter sí "1 de 2 mensajes coincide"
else record Logs TestMetricFilter no "$(short "$out")"; fi

# ---------------------------------------------------------------- Logs: eventos
if try out put_events "$GROUP_A" \
  "$(log_line saga-orchestrator-service SAGA_COMPLETED info '{"duration_ms":1200}')" \
  "$(log_line saga-orchestrator-service SAGA_COMPLETED info '{"duration_ms":800}')" \
  "$(log_line saga-orchestrator-service SAGA_COMPENSATED warn '{"duration_ms":900}')" \
  "$(log_line saga-orchestrator-service STEP_FAILED warn '{"error":{"type":"SagaStepFailure","code":"CHARGER_HARDWARE_FAULT"}}')" \
  && put_events "$GROUP_B" \
    "$(log_line billing-wallet-service http_request error '{"http_status":503}')" \
    "$(log_line billing-wallet-service http_request info '{"http_status":200}')" >/dev/null; then
  record Logs PutLogEvents sí "4 + 2 eventos JSON"
else record Logs PutLogEvents no "$(short "$out")"; fi
sleep 2

if try out aws logs get-log-events --log-group-name "$GROUP_A" --log-stream-name "$STREAM" --start-from-head --query 'length(events)' --output text && [[ "$out" == 4 ]]; then
  record Logs GetLogEvents sí "4 eventos"
else record Logs GetLogEvents no "obtuvo: $(short "$out")"; fi

if try out aws logs filter-log-events --log-group-name "$GROUP_A" --filter-pattern "\"SAGA_COMPENSATED\"" --query 'length(events)' --output text && [[ "$out" == 1 ]]; then
  record Logs "FilterLogEvents (texto)" sí "1 coincidencia"
else record Logs "FilterLogEvents (texto)" no "obtuvo: $(short "$out")"; fi

if try out aws logs filter-log-events --log-group-name "$GROUP_A" --filter-pattern "{ \$.correlation_id = \"${CORR}\" }" --query 'length(events)' --output text && [[ "$out" == 4 ]]; then
  record Logs "FilterLogEvents (JSON \$.correlation_id)" sí "4 coincidencias"
else record Logs "FilterLogEvents (JSON)" no "obtuvo: $(short "$out")"; fi

if try out aws logs filter-log-events --log-group-name "$GROUP_B" --filter-pattern '{ $.http_status >= 500 }' --query 'length(events)' --output text && [[ "$out" == 1 ]]; then
  record Logs "FilterLogEvents (JSON numérico >=)" sí "1 coincidencia"
else record Logs "FilterLogEvents (JSON numérico)" no "obtuvo: $(short "$out")"; fi

if try out aws logs filter-log-events --log-group-name "$GROUP_A" --filter-pattern '{ $.error.code = "CHARGER_HARDWARE_FAULT" }' --query 'length(events)' --output text && [[ "$out" == 1 ]]; then
  record Logs "FilterLogEvents (JSON anidado \$.error.code)" sí "1 coincidencia"
else record Logs "FilterLogEvents (JSON anidado)" no "obtuvo: $(short "$out")"; fi

# Varios grupos a la vez (traza de una SAGA en todos los servicios): Logs Insights.
QSTART=$(( $(date +%s) - 600 )); QEND=$(( $(date +%s) + 60 ))
insights() { # <consulta> → imprime "status filas"
  local qid status rows
  qid="$(aws logs start-query --log-group-names "$GROUP_A" "$GROUP_B" --start-time "$QSTART" --end-time "$QEND" --query-string "$1" --query queryId --output text)" || return 1
  for _ in $(seq 1 20); do
    read -r status rows < <(aws logs get-query-results --query-id "$qid" --query '[status, length(results)]' --output text)
    [[ "$status" == Complete || "$status" == Failed ]] && break
    sleep 1
  done
  echo "$status $rows"
}
if try out insights "fields @timestamp, service_name, event | filter correlation_id = \"${CORR}\" | sort @timestamp asc" && [[ "$out" == "Complete 6" ]]; then
  record Logs "StartQuery/GetQueryResults (Insights: fields·filter·sort, 2 grupos)" sí "6 filas de 2 servicios"
else record Logs "StartQuery (fields/filter/sort)" no "resultado: $(short "$out")"; fi

if try out insights 'stats count(*) by service_name' && [[ "$out" == Complete* && "$out" != "Complete 0" ]]; then
  record Logs "StartQuery (Insights: stats … by)" sí "$out"
else record Logs "StartQuery (Insights: stats … by)" no "resultado: $(short "$out")"; fi

# --------------------------------------------- Logs → Metrics: metric filters generan datos
STAT_START="$(date -u -d '-10 min' +%FT%TZ)"; STAT_END="$(date -u -d '+5 min' +%FT%TZ)"
stat() { # <métrica> <estadística> [dimensiones...]
  aws cloudwatch get-metric-statistics --namespace "$NS" --metric-name "$1" --statistics "$2" \
    --start-time "$STAT_START" --end-time "$STAT_END" --period 3600 "${@:3}" --query "Datapoints[0].$2" --output text
}
sleep 2
if try out stat SagaCompensated Sum && [[ "$out" == 1.0 ]]; then
  record "Logs→Metrics" "Metric filter genera la métrica (contador)" sí "SagaCompensated Sum=1"
else record "Logs→Metrics" "Metric filter genera la métrica" no "Sum=$(short "$out")"; fi

if try out stat SagaDuration Average && [[ "$out" == 1000.0 ]]; then
  record "Logs→Metrics" "Valor desde \$.duration_ms" sí "SagaDuration Average=1000 (1200 y 800)"
else record "Logs→Metrics" "Valor desde campo" no "Average=$(short "$out")"; fi

if try out stat ServiceErrors Sum --dimensions Name=ServiceName,Value=billing-wallet-service && [[ "$out" == 1.0 ]]; then
  record "Logs→Metrics" "Dimensión desde \$.service_name" sí "ServiceErrors{ServiceName=billing-wallet-service} Sum=1"
else record "Logs→Metrics" "Dimensión desde campo" no "Sum=$(short "$out")"; fi

# EMF: ¿Floci extrae métricas de un log con bloque _aws?
EMF="$(jq -cn --arg ns "$NS" --argjson t "$(now_ms)" '{_aws:{Timestamp:$t,CloudWatchMetrics:[{Namespace:$ns,Dimensions:[["ServiceName"]],Metrics:[{Name:"EmfProbe",Unit:"Count"}]}]},ServiceName:"probe",EmfProbe:5}')"
put_events "$GROUP_B" "$EMF" >/dev/null 2>&1 || true
sleep 2
if try out stat EmfProbe Sum --dimensions Name=ServiceName,Value=probe && [[ "$out" == 5.0 ]]; then
  record "Logs→Metrics" "Embedded Metric Format (EMF)" sí "EmfProbe Sum=5"
else record "Logs→Metrics" "Embedded Metric Format (EMF)" no "sin datapoints (Sum=$(short "$out"))"; fi

# ---------------------------------------------------------------- Metrics
if try out aws cloudwatch put-metric-data --namespace "$NS" --metric-data \
  "MetricName=Requests,Value=10,Unit=Count" "MetricName=Errors,Value=2,Unit=Count"; then
  record Metrics PutMetricData sí "2 métricas"
else record Metrics PutMetricData no "$(short "$out")"; fi
sleep 1

if try out aws cloudwatch list-metrics --namespace "$NS" --query 'length(Metrics)' --output text && (( out >= 4 )); then
  record Metrics ListMetrics sí "${out} métricas en el namespace"
else record Metrics ListMetrics no "obtuvo: $(short "$out")"; fi

if try out stat Errors Sum && [[ "$out" == 2.0 ]]; then
  record Metrics GetMetricStatistics sí "Errors Sum=2"
else record Metrics GetMetricStatistics no "obtuvo: $(short "$out")"; fi

QUERIES="$(jq -cn --arg ns "$NS" '[
  {Id:"e",MetricStat:{Metric:{Namespace:$ns,MetricName:"Errors"},Period:3600,Stat:"Sum"}},
  {Id:"r",MetricStat:{Metric:{Namespace:$ns,MetricName:"Requests"},Period:3600,Stat:"Sum"}},
  {Id:"rate",Expression:"100*e/r"}]')"
if try out aws cloudwatch get-metric-data --metric-data-queries "$QUERIES" --start-time "$STAT_START" --end-time "$STAT_END"; then
  e="$(jq -r '.MetricDataResults[] | select(.Id=="e") | .Values[0] // "vacío"' <<<"$out")"
  rate="$(jq -r '.MetricDataResults[] | select(.Id=="rate") | .Values[0] // "vacío"' <<<"$out")"
  [[ "$e" == 2* ]] && record Metrics "GetMetricData (MetricStat)" sí "e=${e}" || record Metrics "GetMetricData (MetricStat)" no "e=${e}"
  [[ "$rate" == 20* ]] && record Metrics "GetMetricData (metric math 100*e/r)" sí "rate=${rate}" || record Metrics "GetMetricData (metric math)" no "rate=${rate}"
else record Metrics GetMetricData no "$(short "$out")"; fi

if try out aws cloudwatch put-dashboard --dashboard-name "${PREFIX}-dash" --dashboard-body \
  "$(jq -cn --arg ns "$NS" '{widgets:[{type:"metric",x:0,y:0,width:6,height:6,properties:{metrics:[[$ns,"Errors"]],region:"us-east-1",stat:"Sum",period:300}}]}')" \
  && [[ "$(aws cloudwatch get-dashboard --dashboard-name "${PREFIX}-dash" --query DashboardName --output text)" == "${PREFIX}-dash" ]]; then
  record Metrics "PutDashboard + GetDashboard" sí "guardado y devuelto (sin render)"
else record Metrics PutDashboard no "$(short "$out")"; fi

# Alarma de una sola métrica sobre una métrica producida por metric filter.
if try out aws cloudwatch put-metric-alarm --alarm-name "${PREFIX}-alarm" --namespace "$NS" --metric-name SagaCompensated \
  --statistic Sum --period 60 --evaluation-periods 1 --threshold 0 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching; then
  record Metrics PutMetricAlarm sí "SagaCompensated Sum > 0 (60 s)"
  # Un evento nuevo (dentro del período en curso) para que la alarma tenga datos recientes.
  put_events "$GROUP_A" "$(log_line saga-orchestrator-service SAGA_COMPENSATED warn '{}')" >/dev/null
  state=""
  for _ in $(seq 1 $(( ALARM_WAIT / 5 ))); do
    state="$(aws cloudwatch describe-alarms --alarm-names "${PREFIX}-alarm" --query 'MetricAlarms[0].StateValue' --output text)"
    [[ "$state" == ALARM ]] && break
    sleep 5
  done
  if [[ "$state" == ALARM ]]; then
    record Metrics "Evaluación de alarma (OK/INSUFFICIENT_DATA → ALARM)" sí "pasó a ALARM"
  else
    record Metrics "Evaluación de alarma" no "estado tras ${ALARM_WAIT}s: ${state}"
  fi
  if try out aws cloudwatch set-alarm-state --alarm-name "${PREFIX}-alarm" --state-value OK --state-reason probe \
    && (( $(aws cloudwatch describe-alarm-history --alarm-name "${PREFIX}-alarm" --query 'length(AlarmHistoryItems)' --output text) >= 1 )); then
    record Metrics "SetAlarmState + DescribeAlarmHistory" sí "historial registrado"
  else record Metrics SetAlarmState no "$(short "$out")"; fi
else record Metrics PutMetricAlarm no "$(short "$out")"; fi

# ---------------------------------------------------------------- Informe
{
  echo "# CloudWatch en Floci ${FLOCI_VERSION} — $(date -u +%FT%TZ)"
  echo
  echo "| Servicio | Operación | ¿Funciona? | Evidencia |"
  echo "| --- | --- | --- | --- |"
  printf '%s\n' "${ROWS[@]}"
} | tee "$REPORT"
log_info "Informe: ${REPORT}"
