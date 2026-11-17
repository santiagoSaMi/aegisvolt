#!/usr/bin/env bash
# Plan de Terraform de un pull request en un runner hospedado (ADR-0035). NUNCA aplica el
# commit del PR.
#
# Uso: scripts/ci/terraform-pr-plan.sh <dev|test|prod> <sha de la rama destino>
#
# El estado real del ambiente no existe en el runner: vive en un Floci local y GitHub no
# persiste nada entre ejecuciones. Para no presentar un estado vacío como si fuera el del
# ambiente, el estado se RECONSTRUYE:
#   1. Floci efímero en el runner (versión fijada por digest).
#   2. Se aplica la configuración de la RAMA DESTINO (su commit, con sus propios scripts)
#      en el workspace del ambiente: es lo que el despliegue post-merge de esa rama aplicó.
#   3. Se planifica el commit del PR sobre ese estado → el diff que produciría el merge.
# Si la rama destino aún no tiene Terraform, el plan es "desde cero" y así se declara.
# El resumen va a GITHUB_STEP_SUMMARY (solo direcciones y acciones).
set -euo pipefail
ENV="${1:?ambiente}"; BASE_SHA="${2:?sha de la rama destino}"
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || { echo "Ambiente inválido: $ENV" >&2; exit 1; }
HEAD_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_DIR="${RUNNER_TEMP:-/tmp}/aegisvolt-base"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
export TF_VAR_eks_enabled_override=true   # el runner tiene memoria para un k3s (L-11 es local)

"${HEAD_DIR}/scripts/floci/start.sh"

rm -rf "$BASE_DIR"
git -C "$HEAD_DIR" worktree add --detach "$BASE_DIR" "$BASE_SHA" >/dev/null
trap 'git -C "$HEAD_DIR" worktree remove --force "$BASE_DIR" >/dev/null 2>&1 || true' EXIT

if [[ -x "${BASE_DIR}/scripts/floci/terraform-live.sh" && -f "${BASE_DIR}/infra/terraform/live/envs/${ENV}.tfvars" \
      && -x "${BASE_DIR}/scripts/floci/terraform-bootstrap.sh" ]]; then
  MODE=incremental
  echo "Reconstruyendo el estado de ${ENV} con la rama destino (${BASE_SHA:0:12})…"
  "${BASE_DIR}/scripts/floci/terraform-bootstrap.sh" apply
  "${BASE_DIR}/scripts/floci/terraform-global.sh" apply
  "${BASE_DIR}/scripts/floci/terraform-live.sh" "$ENV" apply
else
  MODE=from-scratch
  echo "La rama destino (${BASE_SHA:0:12}) no tiene Terraform: plan desde cero."
  "${HEAD_DIR}/scripts/floci/terraform-bootstrap.sh" apply   # el backend necesita el bucket
fi

"${HEAD_DIR}/scripts/floci/terraform-bootstrap.sh" plan
"${HEAD_DIR}/scripts/floci/terraform-global.sh" plan
# --allow-destroy: en un PR la destrucción se MUESTRA (resumen con aviso) en vez de abortar.
"${HEAD_DIR}/scripts/floci/terraform-live.sh" "$ENV" plan --allow-destroy

TMP="${HEAD_DIR}/infra/local/floci/.tmp"
{
  echo "## Terraform plan · workspace \`${ENV}\`"
  echo
  if [[ "$MODE" == incremental ]]; then
    echo "Estado **reconstruido** en un Floci efímero aplicando la rama destino (\`${BASE_SHA:0:12}\`); plan del PR sobre ese estado."
  else
    echo "La rama destino (\`${BASE_SHA:0:12}\`) no contiene Terraform: **plan desde cero** (todo se crea)."
  fi
  echo "No es el estado del Floci persistente del autor, que no es accesible desde GitHub (ADR-0035). EKS habilitado en el runner (\`TF_VAR_eks_enabled_override=true\`)."
  echo
  "${HEAD_DIR}/scripts/ci/terraform-plan-summary.sh" bootstrap "${TMP}/bootstrap.tfplan" "bootstrap"
  "${HEAD_DIR}/scripts/ci/terraform-plan-summary.sh" global "${TMP}/global.tfplan" "global"
  "${HEAD_DIR}/scripts/ci/terraform-plan-summary.sh" live "${TMP}/live-${ENV}.tfplan" "live · ${ENV}"
} >> "$SUMMARY"
echo "Plan de ${ENV} generado (${MODE}). No se aplica nada del PR."
