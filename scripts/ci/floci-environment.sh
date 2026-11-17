#!/usr/bin/env bash
# Levanta un ambiente COMPLETO y TEMPORAL en el runner (ADR-0035): Floci efímero +
# Terraform (bootstrap, global y el workspace del ambiente). No toca ningún Floci
# persistente: todo vive y muere con el runner.
#
# Uso: scripts/ci/floci-environment.sh <dev|test|prod>
#
# El plan de live se regenera para el commit integrado, se publica (resumen sin datos
# sensibles), se revisa (no debe destruir nada) y se aplica ESE mismo plan.
set -euo pipefail
ENV="${1:?ambiente}"
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || { echo "Ambiente inválido: $ENV" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
export TF_VAR_eks_enabled_override=true

"${ROOT}/scripts/floci/start.sh"
"${ROOT}/scripts/floci/terraform-bootstrap.sh" apply
"${ROOT}/scripts/floci/terraform-global.sh" apply

# Plan del commit integrado (terraform-live.sh lo rechaza si destruye algo).
"${ROOT}/scripts/floci/terraform-live.sh" "$ENV" plan
PLAN="${ROOT}/infra/local/floci/.tmp/live-${ENV}.tfplan"
{
  echo "## Terraform apply · workspace \`${ENV}\` (Floci temporal del runner)"
  echo
  echo "Commit \`${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}\`. Ambiente efímero: no modifica ningún Floci persistente."
  echo
  "${ROOT}/scripts/ci/terraform-plan-summary.sh" live "$PLAN" "Plan aplicado"
} >> "$SUMMARY"

# shellcheck source=../floci/terraform-lib.sh
source "${ROOT}/scripts/floci/terraform-lib.sh"
tf_guard
tf live workspace select "$ENV" >/dev/null
[[ "$(tf live workspace show)" == "$ENV" ]] || { echo "Workspace incorrecto" >&2; exit 1; }
tf live apply -input=false "$PLAN"
echo "Ambiente ${ENV} aplicado en el Floci temporal."
