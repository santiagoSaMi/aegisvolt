#!/usr/bin/env bash
# Diagnóstico tras un fallo en el ambiente temporal (solo lectura). No imprime Secrets,
# variables de entorno ni credenciales (las del ambiente son ficticias, pero tampoco se
# vuelcan). Uso: scripts/ci/diagnostics.sh <dev|test|prod>
set -uo pipefail
ENV="${1:-dev}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${ROOT}/infra/local/floci/.tmp/k8s-${ENV}"
section() { echo; echo "::group::$1"; }
endsection() { echo "::endgroup::"; }

section "Contenedores Docker"; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'; endsection
section "Floci (últimas 150 líneas)"; docker logs --tail 150 aegisvolt-floci 2>&1; endsection
if [[ -f "${STATE}/kubeconfig" && -f "${STATE}/kube-credentials.env" ]]; then
  k() { (set -a; source "${STATE}/kube-credentials.env"; set +a; KUBECONFIG="${STATE}/kubeconfig" kubectl "$@"); }
  section "Pods"; k get pods -A -o wide; endsection
  section "Rollout y análisis"; k -n aegisvolt get rollout,analysisrun 2>&1; endsection
  section "Eventos recientes"; k get events -A --sort-by=.lastTimestamp 2>&1 | tail -60; endsection
  section "Logs de pods no listos"
  for p in $(k -n aegisvolt get pods --no-headers 2>/dev/null | awk '$2 !~ /^([0-9]+)\/\1$/ {print $1}'); do
    echo "--- ${p}"; k -n aegisvolt logs "$p" --tail 60 --all-containers 2>&1
  done
  endsection
else
  echo "Sin kubeconfig del ambiente ${ENV}: el clúster no llegó a crearse."
fi
exit 0
