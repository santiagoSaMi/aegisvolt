#!/usr/bin/env bash
# Construye las imágenes de AegisVolt con una etiqueta INMUTABLE por commit (ADR-0031).
#
# Uso: scripts/docker/build-images.sh [--only <app>[,<app>…]] [--tag-file <ruta>]
#
# - Árbol limpio      → aegisvolt/<app>:sha-<commit 12>
# - Cambios sin commit → aegisvolt/<app>:sha-<commit 12>-dirty-<epoch>  (nunca se reutiliza)
# - Nunca `latest`. La etiqueta usada se imprime y, con --tag-file, se guarda en un archivo.
# - Reproducible: imágenes base fijadas por digest, lockfile congelado y versión de pnpm fija.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

declare -A DOCKERFILES=(
  [station-reservation]=services/station-reservation/Dockerfile
  [billing-wallet]=services/billing-wallet/Dockerfile
  [energy-dispatch]=services/energy-dispatch/Dockerfile
  [saga-orchestrator]=services/saga-orchestrator/Dockerfile
  [graphql-api]=apps/graphql-api/Dockerfile
  [web]=apps/web/Dockerfile
)
ORDER=(station-reservation billing-wallet energy-dispatch saga-orchestrator graphql-api web)

ONLY=""; TAG_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) shift; ONLY="${1:?--only requiere una lista}" ;;
    --tag-file) shift; TAG_FILE="${1:?--tag-file requiere una ruta}" ;;
    *) echo "Opción desconocida: $1" >&2; exit 1 ;;
  esac
  shift
done

SHA="$(git rev-parse --short=12 HEAD)"
if [[ -z "$(git status --porcelain)" ]]; then
  TAG="sha-${SHA}"
else
  TAG="sha-${SHA}-dirty-$(date -u +%Y%m%d%H%M%S)"
  echo "[warn] Hay cambios sin commit: etiqueta ${TAG} (no apta para promoción entre ambientes)" >&2
fi

# ~/.docker/config.json con un credsStore inexistente rompe los pulls (ver lib.sh de Floci).
if grep -q '"credsStore"' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null \
   && ! command -v "docker-credential-$(sed -n 's/.*"credsStore"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${DOCKER_CONFIG:-$HOME/.docker}/config.json")" >/dev/null; then
  export DOCKER_CONFIG="${REPO_ROOT}/infra/local/floci/.tmp/docker-config"
  mkdir -p "$DOCKER_CONFIG"; [[ -f "$DOCKER_CONFIG/config.json" ]] || echo '{}' > "$DOCKER_CONFIG/config.json"
fi

for app in "${ORDER[@]}"; do
  if [[ -n "$ONLY" && ",${ONLY}," != *",${app},"* ]]; then continue; fi
  echo "==> aegisvolt/${app}:${TAG}"
  docker build --file "${DOCKERFILES[$app]}" --build-arg "GIT_SHA=${SHA}" \
    --tag "aegisvolt/${app}:${TAG}" .
done

echo "$TAG"
[[ -z "$TAG_FILE" ]] || echo "$TAG" > "$TAG_FILE"
