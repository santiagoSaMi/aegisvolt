#!/usr/bin/env bash
# Canary de un release de graphql-api en un ambiente TEMPORAL del runner (ADR-0032, ADR-0035).
#
# Uso: scripts/ci/canary-release.sh <dev|test|prod> <línea base> <success|failure>
#
#   1. Línea base = la versión estable (en un push, la rama antes del merge). Debe contener
#      el canary (infra/k8s/components/canary); si no, no hay release que comparar y se
#      declara "canary no ejecutado" (exit 3): nunca se presenta como éxito.
#   2. Floci temporal + Terraform del commit integrado (scripts/ci/floci-environment.sh).
#   3. Imágenes de la línea base (sha-<base>) desplegadas como versión ESTABLE.
#   4. canary-demo.sh libera graphql-api del commit integrado (sha-<head>) como canary:
#      Argo Rollouts reparte el tráfico por peso en Traefik y el AnalysisTemplate decide
#      (este script no reparte tráfico). Promueve si pasa; si falla, Argo aborta, el tráfico
#      vuelve a la estable y el rollback queda en el informe.
#   failure = demostración: el canary lleva un error de configuración y se espera el abort.
#
# Salida: 0 = resultado esperado; 1 = canary abortado (o versión rota promovida);
#         3 = canary no ejecutado (sin línea base comparable).
set -euo pipefail
ENV="${1:?ambiente}"; BASELINE="${2:?línea base}"; SCENARIO="${3:-success}"
[[ "$ENV" =~ ^(dev|test|prod)$ && "$SCENARIO" =~ ^(success|failure)$ ]] || { echo "Argumentos inválidos" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
BASE_DIR="${RUNNER_TEMP:-/tmp}/aegisvolt-baseline"

HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
BASE_SHA="$(git -C "$ROOT" rev-parse --verify "${BASELINE}^{commit}")"
not_run() {
  echo "::warning title=Canary no ejecutado::$1"
  { echo "## Canary · ${ENV}"; echo; echo "**Canary NO ejecutado.** $1"; } >> "$SUMMARY"
  exit 3
}
[[ "$BASE_SHA" != "$HEAD_SHA" ]] || not_run "La línea base es el mismo commit (${HEAD_SHA:0:12}): no hay release nuevo."
git -C "$ROOT" cat-file -e "${BASE_SHA}:infra/k8s/components/canary/rollout.yaml" 2>/dev/null \
  || not_run "La línea base ${BASE_SHA:0:12} no tiene el canary de Argo Rollouts: es el primer despliegue con canary y no hay versión estable comparable."
git -C "$ROOT" cat-file -e "${BASE_SHA}:scripts/docker/build-images.sh" 2>/dev/null \
  || not_run "La línea base ${BASE_SHA:0:12} no construye imágenes."

echo "Estable: ${BASE_SHA:0:12} · canary: ${HEAD_SHA:0:12} · ambiente ${ENV} · escenario ${SCENARIO}"

# 2. Ambiente temporal con la infraestructura del commit integrado.
"${ROOT}/scripts/ci/floci-environment.sh" "$ENV"

# 3. Versión estable = imágenes de la línea base (árbol limpio → sha-<base>).
rm -rf "$BASE_DIR"
git -C "$ROOT" worktree add --detach "$BASE_DIR" "$BASE_SHA" >/dev/null
trap 'git -C "$ROOT" worktree remove --force "$BASE_DIR" >/dev/null 2>&1 || true' EXIT
"${BASE_DIR}/scripts/docker/build-images.sh" --tag-file "${RUNNER_TEMP:-/tmp}/baseline-tag"
STABLE_TAG="$(cat "${RUNNER_TEMP:-/tmp}/baseline-tag")"
"${ROOT}/scripts/floci/k8s-deploy.sh" "$ENV" --tag "$STABLE_TAG"

# 4. Release canary (Argo + AnalysisTemplate deciden).
"${ROOT}/scripts/floci/canary-demo.sh" "$ENV" "$SCENARIO"
