#!/usr/bin/env bash
# Cambia una feature flag del ambiente indicado EN FLOCI usando el caso de uso
# UpdateFeatureFlag del graphql-api (autorización, versión condicional y
# auditoría). Se niega a usar endpoints no locales.
# Uso: scripts/flags/set.sh <local|dev|test|prod> <FLAG> <true|false> [--expected-version N]
set -euo pipefail
if [[ $# -lt 3 ]]; then
  echo "Uso: $0 <local|dev|test|prod> <FLAG> <true|false> [--expected-version N]" >&2
  exit 2
fi
env_name="$1"
shift
cd "$(dirname "$0")/../../apps/graphql-api"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
APP_ENV="$env_name" exec node scripts/set-flag.ts "$@"
