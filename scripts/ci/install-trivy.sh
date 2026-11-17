#!/usr/bin/env bash
# Instala el binario oficial de Trivy verificado por sha256 en $RUNNER_TEMP (ADR-0035).
set -euo pipefail
VERSION=0.76.1
SHA256=c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0
DEST="${RUNNER_TEMP:-/tmp}"
f="trivy_${VERSION}_Linux-64bit.tar.gz"
curl -fsSLo "${DEST}/${f}" "https://github.com/aquasecurity/trivy/releases/download/v${VERSION}/${f}"
echo "${SHA256}  ${DEST}/${f}" | sha256sum -c -
tar -xzf "${DEST}/${f}" -C "${DEST}" trivy
"${DEST}/trivy" --version | head -1
