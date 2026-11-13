#!/usr/bin/env bash
# Cambia una feature flag en la tabla de un ambiente LOCAL (Floci), con versión
# condicional y auditoría (ADR-0007). Se niega a usar endpoints no locales.
# Uso: scripts/flags/set.sh <env> <FLAG> <true|false> [usuario]
set -euo pipefail
if [[ $# -lt 3 ]]; then
  echo "Uso: $0 <env> <FLAG> <true|false> [usuario]" >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
exec pnpm --silent --filter @aegisvolt/feature-flags flags:set "$@"
