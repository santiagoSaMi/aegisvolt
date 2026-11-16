#!/usr/bin/env bash
# Pruebas de scripts/ci/promotion-guard.sh: todas las combinaciones relevantes.
set -euo pipefail
GUARD="$(dirname "$0")/promotion-guard.sh"
R=owner/aegisvolt; F=someone/aegisvolt
fails=0
expect() { # <ok|reject> <origen> <destino> [repo origen]
  local want="$1" head="$2" base="$3" repo="${4:-$R}" got
  if "$GUARD" "$head" "$base" "$repo" "$R" >/dev/null 2>&1; then got=ok; else got=reject; fi
  if [[ "$got" == "$want" ]]; then echo "  ✓ ${head} (${repo}) → ${base}: ${got}"
  else echo "  ✗ ${head} (${repo}) → ${base}: esperado ${want}, obtenido ${got}"; fails=$((fails + 1)); fi
}
expect ok     feature/login dev
expect ok     fix/billing-rounding dev
expect ok     chore/deps dev
expect ok     docs/runbook dev
expect ok     feature/login dev "$F"          # aporte externo desde un fork hacia dev
expect ok     dependabot/npm_and_yarn/vitest-5.2.0 dev
expect reject dependabot/npm_and_yarn/x dev "$F"   # "dependabot" de un fork
expect reject dependabot/npm_and_yarn/x test
expect ok     dev test
expect ok     test prod
expect reject feature/login test               # feature directo a test
expect reject feature/login prod               # feature directo a prod
expect reject dev prod                         # saltar test
expect reject test dev                         # promoción inversa
expect reject prod test
expect reject main dev
expect reject hotfix/x dev
expect reject feature/ dev                     # nombre vacío
expect reject dev test "$F"                    # rama dev de un fork
expect reject test prod "$F"
expect reject feature/x main                   # destino no protegido
if "$GUARD" "" dev "$R" "$R" >/dev/null 2>&1; then echo "  ✗ argumentos vacíos aceptados"; fails=$((fails + 1)); else echo "  ✓ argumentos vacíos rechazados"; fi
[[ "$fails" == 0 ]] && echo "promotion-guard: todas las pruebas pasan" || { echo "promotion-guard: ${fails} fallos"; exit 1; }
