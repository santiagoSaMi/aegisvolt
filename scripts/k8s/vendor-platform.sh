#!/usr/bin/env bash
# Descarga los manifiestos de terceros de la plataforma de Kubernetes y verifica su
# sha256 FIJADO (ADR-0032). No se versionan en Git (infra/k8s/platform/*/vendor/).
#
#   Argo Rollouts v1.10.1 (2026-10-12): install.yaml
#   Traefik v3.7.16 (2026-10-20): CRDs (incluye TraefikService) y RBAC
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

fetch() { # <url> <destino> <sha256>
  local url=$1 dest=$2 sum=$3
  if [[ -f "$dest" ]] && echo "${sum}  ${dest}" | sha256sum --check --status; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  curl -fsSL --retry 3 --max-time 300 -o "${dest}.tmp" "$url"
  echo "${sum}  ${dest}.tmp" | sha256sum --check --status || { rm -f "${dest}.tmp"; echo "sha256 inválido: ${url}" >&2; exit 1; }
  mv "${dest}.tmp" "$dest"
}

fetch https://github.com/argoproj/argo-rollouts/releases/download/v1.10.1/install.yaml \
  "${ROOT}/infra/k8s/platform/argo-rollouts/vendor/install.yaml" \
  149148429a6f8258b789003ffb9bc6698a526d611ecb1b185624217cf51bae7f
fetch https://raw.githubusercontent.com/traefik/traefik/v3.7.16/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml \
  "${ROOT}/infra/k8s/platform/traefik/vendor/crds.yaml" \
  ecbe44ea9b011cda1b562716175b882d59cf6561fe6d3e5832df7ee072687d17
fetch https://raw.githubusercontent.com/traefik/traefik/v3.7.16/docs/content/reference/dynamic-configuration/kubernetes-crd-rbac.yml \
  "${ROOT}/infra/k8s/platform/traefik/vendor/rbac.yaml" \
  01e592c73d42c225351fe41b40162fc77ec5239773e7d7be81d40bba08f65f27
echo "Manifiestos de plataforma verificados."
