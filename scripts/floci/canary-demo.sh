#!/usr/bin/env bash
# Demostración del canary de graphql-api (Argo Rollouts + Traefik + CloudWatch de Floci).
#
# Uso: scripts/floci/canary-demo.sh <dev|test|prod> <success|failure>
# Código de salida = veredicto de Argo frente a lo esperado (lo usa canary-deployment.yml):
#   success → 0 si Argo PROMOVIÓ; 1 si ABORTÓ (rollback registrado en el informe).
#   failure → 0 si Argo ABORTÓ y se restauró la estable; 1 si la versión rota se promovió.
#   success  versión nueva sana: 20 % → análisis → 50 % → análisis → 100 % (promoción)
#   failure  versión nueva con un error de configuración real (URL de station-reservation
#            incorrecta): el análisis de tasa de error falla → abort → 100 % a la estable;
#            al final se restaura la plantilla estable.
#
# Requiere `scripts/floci/k8s-deploy.sh <env>` con el Rollout en Healthy.
# Mide la distribución REAL del tráfico: cada respuesta de /graphql que pasa por Traefik
# trae la cabecera x-service-version de la versión que la atendió (no se infiere de pods).
# Evidencias en infra/local/floci/.tmp/k8s-<env>/canary-<escenario>-<fecha>/.
source "$(dirname "$0")/lib.sh"

ENV="${1:-}"; SCENARIO="${2:-}"
[[ "$ENV" =~ ^(dev|test|prod)$ && "$SCENARIO" =~ ^(success|failure)$ ]] || die "Uso: $0 <dev|test|prod> <success|failure>"
require_cmd kubectl
require_cmd jq
load_aws_local_env
ensure_usable_docker_config
STATE="${FLOCI_TMP_DIR}/k8s-${ENV}"
[[ -f "${STATE}/kubeconfig" ]] || die "Primero: scripts/floci/k8s-deploy.sh ${ENV}"
# shellcheck source=/dev/null
source "${FLOCI_TMP_DIR}/identity-${ENV}.env"
k() { (set -a; source "${STATE}/kube-credentials.env"; set +a; KUBECONFIG="${STATE}/kubeconfig" kubectl "$@"); }
OUT="${STATE}/canary-${SCENARIO}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
REGISTRY="localhost:4566/000000000000/us-east-1"

PHASE="$(k -n aegisvolt get rollout graphql-api -o jsonpath='{.status.phase}')"
[[ "$PHASE" == Healthy ]] || die "El Rollout está en ${PHASE}: debe estar Healthy antes de una nueva versión"
STABLE_VERSION="$(k -n aegisvolt get deploy graphql-api -o jsonpath='{.spec.template.metadata.labels.version}')"
STABLE_IMAGE="$(k -n aegisvolt get deploy graphql-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
INITIAL_RS="$(k -n aegisvolt get rollout graphql-api -o jsonpath='{.status.stableRS}')"

# --- 1. Versión nueva de graphql-api (imagen con etiqueta inmutable nueva) ------------------
"${REPO_ROOT}/scripts/docker/build-images.sh" --only graphql-api --tag-file "${OUT}/tag" >/dev/null
NEW_VERSION="$(cat "${OUT}/tag")"
[[ "$NEW_VERSION" != "$STABLE_VERSION" ]] \
  || die "La versión canary (${NEW_VERSION}) es la misma que la estable: no hay release que evaluar"
aws ecr get-login-password | docker login --username AWS --password-stdin localhost:4566 >/dev/null 2>&1
docker tag "aegisvolt/graphql-api:${NEW_VERSION}" "${REGISTRY}/aegisvolt/graphql-api:${NEW_VERSION}"
docker push -q "${REGISTRY}/aegisvolt/graphql-api:${NEW_VERSION}" >/dev/null
log_ok "Estable: ${STABLE_VERSION} · Canary: ${NEW_VERSION}"

# --- 2. Tráfico real a través de Traefik ----------------------------------------------------
k -n traefik port-forward svc/traefik 18090:80 >/dev/null 2>&1 &
PF=$!
LOAD=""
cleanup() { kill $PF ${LOAD:-} 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:18090/healthz 2>/dev/null && break; sleep 1; done
TOKEN="$(curl -fsS http://127.0.0.1:18090/auth/cognito -H 'content-type: application/x-amz-json-1.1' \
  -H 'x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth' \
  -d "{\"AuthFlow\":\"USER_PASSWORD_AUTH\",\"ClientId\":\"${COGNITO_CLIENT_ID}\",\"AuthParameters\":{\"USERNAME\":\"operador\",\"PASSWORD\":\"${DEMO_PASSWORD}\"}}" \
  | jq -r .AuthenticationResult.IdToken)"
[[ -n "$TOKEN" && "$TOKEN" != null ]] || die "Login por Traefik fallido"

# Cada línea: epoch_ms versión http_code resultado (ok | error). La consulta lee
# estaciones (graphql-api → station-reservation), como un cliente real.
loadgen() {
  local hdr body
  hdr="$(mktemp)"; body="$(mktemp)"
  while true; do
    code="$(curl -s -D "$hdr" -o "$body" -w '%{http_code}' --max-time 5 http://127.0.0.1:18090/graphql \
      -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" \
      -d '{"query":"query CanaryProbe { stations(city: \"medellin\") { stationId } }","operationName":"CanaryProbe"}')"
    version="$(tr -d '\r' < "$hdr" | sed -n 's/^x-service-version: //Ip' | head -1)"
    outcome=ok; grep -q '"errors"' "$body" 2>/dev/null && outcome=error
    echo "$(date +%s%3N) ${version:-none} ${code} ${outcome}"
    sleep 0.15
  done
}
loadgen > "${OUT}/traffic.log" &
LOAD=$!
sleep 10   # línea base: 100 % estable

# --- 3. Publicar la versión nueva (dispara el canary) -------------------------------------
NEW_IMAGE="${REGISTRY}/aegisvolt/graphql-api:${NEW_VERSION}"
k -n aegisvolt label rollout graphql-api "version=${NEW_VERSION}" --overwrite >/dev/null
if [[ "$SCENARIO" == success ]]; then
  PATCH="{\"spec\":{\"template\":{\"metadata\":{\"labels\":{\"version\":\"${NEW_VERSION}\"}},\"spec\":{\"containers\":[{\"name\":\"graphql-api\",\"image\":\"${NEW_IMAGE}\"}]}}}}"
else
  # Release con un error de configuración: station-reservation en un puerto inexistente.
  PATCH="{\"spec\":{\"template\":{\"metadata\":{\"labels\":{\"version\":\"${NEW_VERSION}\"}},\"spec\":{\"containers\":[{\"name\":\"graphql-api\",\"image\":\"${NEW_IMAGE}\",\"env\":[{\"name\":\"STATION_RESERVATION_URL\",\"value\":\"http://station-reservation-service:81\"}]}]}}}}"
fi
k -n aegisvolt patch deployment graphql-api --type strategic -p "$PATCH" >/dev/null
echo "$(date +%s%3N) release ${NEW_VERSION}" > "${OUT}/events.log"
log_info "Versión publicada; siguiendo el Rollout (Argo + análisis)…"

# --- 4. Seguimiento: fase, paso y pesos REALES del TraefikService ------------------------------
printf 'epoch_ms\tphase\tstep\tstable_weight\tcanary_weight\tanalysis_runs\n' > "${OUT}/timeline.tsv"
sample() {
  ro="$(k -n aegisvolt get rollout graphql-api -o json)"
  ts="$(k -n aegisvolt get traefikservice graphql-api-split -o json)"
  runs="$(k -n aegisvolt get analysisrun -o json | jq -r '[.items[] | "\(.metadata.name)=\(.status.phase // "Pending")"] | join(",")')"
  phase="$(jq -r '.status.phase' <<<"$ro")"
  step="$(jq -r '.status.currentStepIndex // "-"' <<<"$ro")"
  sw="$(jq -r '[.spec.weighted.services[] | select(.name=="graphql-api") | .weight // 0][0]' <<<"$ts")"
  cw="$(jq -r '[.spec.weighted.services[] | select(.name=="graphql-api-canary") | .weight // 0][0]' <<<"$ts")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date +%s%3N)" "$phase" "$step" "$sw" "$cw" "$runs" >> "${OUT}/timeline.tsv"
  printf '\r[%s] fase=%-11s paso=%-2s pesos estable/canary=%s/%s  ' "$(date +%T)" "$phase" "$step" "$sw" "$cw"
}
END_PHASE=""
for _ in $(seq 1 200); do
  sample
  srs="$(jq -r '.status.stableRS' <<<"$ro")"
  if [[ "$phase" == Healthy && "$srs" != "$INITIAL_RS" && "$srs" == "$(jq -r '.status.currentPodHash' <<<"$ro")" ]]; then END_PHASE=Promoted; break; fi
  if [[ "$phase" == Degraded || "$(jq -r '.status.abort // false' <<<"$ro")" == true ]]; then END_PHASE=Aborted; break; fi
  # Muestra insuficiente (Inconclusive): Argo pausa y espera a un operador. Sin operador
  # (CI), la política es no promover: se aborta y queda registrado.
  if jq -e '[.status.pauseConditions[]?.reason] | index("InconclusiveAnalysisRun")' <<<"$ro" >/dev/null; then
    log_warn "Análisis inconcluso (muestra insuficiente): se aborta el canary"
    k -n aegisvolt patch rollout graphql-api --subresource status --type merge -p '{"status":{"abort":true}}' >/dev/null
  fi
  sleep 5
done
echo "$(date +%s%3N) end ${END_PHASE:-timeout}" >> "${OUT}/events.log"
[[ -n "$END_PHASE" ]] || { echo; die "El canary no terminó a tiempo (ver ${OUT}/timeline.tsv)"; }
# Tráfico posterior al desenlace: se sigue midiendo 30 s (100 % a la versión resultante).
for _ in $(seq 1 6); do sleep 5; sample; done
echo
kill "$LOAD" 2>/dev/null || true; LOAD=""
k -n aegisvolt get analysisrun -o json > "${OUT}/analysisruns.json"
k -n aegisvolt get rollout graphql-api -o yaml > "${OUT}/rollout.yaml"
k -n aegisvolt get traefikservice graphql-api-split -o yaml > "${OUT}/traefikservice.yaml"

# --- 5. Restaurar la plantilla estable tras un abort ---------------------------------------
if [[ "$END_PHASE" == Aborted ]]; then
  k -n aegisvolt label rollout graphql-api "version=${STABLE_VERSION}" --overwrite >/dev/null
  # Vuelve a la plantilla estable (imagen, etiqueta) y quita la variable mal configurada.
  # Con la misma plantilla que el ReplicaSet estable, Argo no crea un canary nuevo.
  k -n aegisvolt patch deployment graphql-api --type strategic -p "{\"spec\":{\"template\":{\"metadata\":{\"labels\":{\"version\":\"${STABLE_VERSION}\"}},\"spec\":{\"containers\":[{\"name\":\"graphql-api\",\"image\":\"${STABLE_IMAGE}\",\"env\":[{\"name\":\"STATION_RESERVATION_URL\",\"\$patch\":\"delete\"}]}]}}}}" >/dev/null
  for _ in $(seq 1 60); do
    [[ "$(k -n aegisvolt get rollout graphql-api -o jsonpath='{.status.phase}')" == Healthy ]] && break; sleep 5
  done
  log_ok "Plantilla estable restaurada: Rollout $(k -n aegisvolt get rollout graphql-api -o jsonpath='{.status.phase}')"
fi

# --- 6. Informe: distribución REAL por tramo de peso -----------------------------------------
python3 - "$OUT" "$STABLE_VERSION" "$NEW_VERSION" "$END_PHASE" <<'PY'
import json, sys, collections, pathlib
out, stable, canary, end = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
traffic = [l.split() for l in (out / "traffic.log").read_text().splitlines() if len(l.split()) == 4]
rows = [l.split("\t") for l in (out / "timeline.tsv").read_text().splitlines()[1:]]
events = (out / "events.log").read_text().split()
release = int(events[0])
# Tramos consecutivos con el mismo peso canary observado en el TraefikService.
segments, last = [], None
for r in rows:
    t, phase, step, sw, cw = int(r[0]), r[1], r[2], r[3], r[4]
    key = (sw, cw)
    if key != last:
        segments.append([t, None, sw, cw, step, phase]); last = key
    else:
        segments[-1][5] = phase
for i, s in enumerate(segments):
    s[1] = segments[i + 1][0] if i + 1 < len(segments) else 10**15
lines = [f"# Canary de graphql-api — `{out.name}`", "",
         f"- Versión estable: `{stable}`", f"- Versión canary: `{canary}`", f"- Desenlace: **{end}**", "",
         "## Distribución real del tráfico (cabecera x-service-version de cada respuesta)", "",
         "| Pesos TraefikService (estable/canary) | Paso | Respuestas | Estable | Canary | Errores canary |",
         "| --- | --- | --- | --- | --- | --- |"]
base = [t for t in traffic if int(t[0]) < release]
if base:
    c = collections.Counter(t[1] for t in base)
    lines.append(f"| antes de publicar | — | {len(base)} | {100*c[stable]/len(base):.1f} % | {100*c[canary]/len(base):.1f} % | — |")
for start, stop, sw, cw, step, phase in segments:
    sample = [t for t in traffic if start <= int(t[0]) < stop and int(t[0]) >= release]
    if not sample:
        continue
    c = collections.Counter(t[1] for t in sample)
    errs = sum(1 for t in sample if t[1] == canary and t[3] == "error")
    lines.append(f"| {sw}/{cw} | {step} ({phase}) | {len(sample)} | {100*c[stable]/len(sample):.1f} % | "
                 f"{100*c[canary]/len(sample):.1f} % | {errs} |")
runs = json.loads((out / "analysisruns.json").read_text())["items"]
lines += ["", "## AnalysisRuns", "", "| AnalysisRun | Fase | Métrica | Mediciones (fase: valor) |", "| --- | --- | --- | --- |"]
for run in sorted(runs, key=lambda r: r["metadata"]["creationTimestamp"]):
    for m in run.get("status", {}).get("metricResults", []):
        ms = "; ".join(f"{x.get('phase')}: {str(x.get('value', ''))[:40]}" for x in m.get("measurements", []))
        lines.append(f"| {run['metadata']['name']} | {run['status'].get('phase')} | {m['name']} ({m.get('phase')}) | {ms} |")
(out / "report.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
PY
log_info "Evidencias: ${OUT}"

# --- 7. Veredicto -------------------------------------------------------------------------------
if [[ "$END_PHASE" == Aborted ]]; then
  {
    echo
    echo "## Rollback"
    echo
    echo "Argo abortó la versión \`${NEW_VERSION}\`: el TraefikService volvió a 100 % para \`${STABLE_VERSION}\`."
    echo "Motivo: $(jq -r '[.items[] | select(.status.phase=="Failed" or .status.phase=="Error" or .status.phase=="Inconclusive") | .status.message] | last // "sin mensaje"' "${OUT}/analysisruns.json")"
  } >> "${OUT}/report.md"
fi
[[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && cat "${OUT}/report.md" >> "$GITHUB_STEP_SUMMARY"
case "${SCENARIO}:${END_PHASE}" in
  success:Promoted) log_ok "Canary promovido por el análisis";;
  failure:Aborted)  log_ok "Canary abortado por el análisis y estable restaurada (esperado)";;
  success:Aborted)  log_error "Canary ABORTADO por el análisis: rollback a ${STABLE_VERSION}"; exit 1;;
  failure:Promoted) log_error "La versión defectuosa fue PROMOVIDA: el análisis no la detectó"; exit 1;;
esac
