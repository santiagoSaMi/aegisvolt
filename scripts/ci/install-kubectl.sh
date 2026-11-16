#!/usr/bin/env bash
# Instala kubectl fijado y verificado por sha256 (misma versión menor que el k3s v1.36 de
# Floci 2.4.0). Uso: scripts/ci/install-kubectl.sh [directorio de destino]
set -euo pipefail
VERSION=v1.36.6
SHA256=29818b6729dc9262b692307470d0558d027725e738be5dd47c760261868a2634
DEST="${1:-${RUNNER_TEMP:-/tmp}/bin}"
mkdir -p "$DEST"
curl -fsSLo "${DEST}/kubectl" "https://dl.k8s.io/release/${VERSION}/bin/linux/amd64/kubectl"
echo "${SHA256}  ${DEST}/kubectl" | sha256sum -c -
chmod +x "${DEST}/kubectl"
[[ -n "${GITHUB_PATH:-}" ]] && echo "$DEST" >> "$GITHUB_PATH"
"${DEST}/kubectl" version --client
