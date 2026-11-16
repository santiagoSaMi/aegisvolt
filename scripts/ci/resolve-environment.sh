#!/usr/bin/env bash
# Determina el ambiente (dev | test | prod) a partir del evento de GitHub (ADR-0035).
#   pull_request      → rama destino (GITHUB_BASE_REF)
#   push / dispatch   → rama que recibió el merge o se eligió (GITHUB_REF_NAME)
# Cualquier otra rama falla: un job de dev nunca puede seleccionar test o prod.
# Escribe `environment=<env>` en GITHUB_OUTPUT (si existe) y lo imprime.
set -euo pipefail
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) env_name="${GITHUB_BASE_REF:-}" ;;
  push|workflow_dispatch|workflow_call) env_name="${GITHUB_REF_NAME:-}" ;;
  *) echo "::error::Evento no soportado: ${GITHUB_EVENT_NAME:-<vacío>}"; exit 1 ;;
esac
case "$env_name" in
  dev|test|prod) ;;
  *) echo "::error title=Ambiente inválido::La rama '${env_name}' no es dev, test ni prod."; exit 1 ;;
esac
if [[ -n "${EXPECTED_ENVIRONMENT:-}" && "$EXPECTED_ENVIRONMENT" != "$env_name" ]]; then
  echo "::error::Ambiente solicitado (${EXPECTED_ENVIRONMENT}) distinto de la rama (${env_name})."; exit 1
fi
[[ -n "${GITHUB_OUTPUT:-}" ]] && echo "environment=${env_name}" >> "$GITHUB_OUTPUT"
echo "Ambiente: ${env_name}"
