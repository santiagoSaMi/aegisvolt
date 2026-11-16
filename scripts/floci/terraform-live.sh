#!/usr/bin/env bash
# Terraform de un ambiente (infra/terraform/live) contra Floci.
#
# Uso: scripts/floci/terraform-live.sh <dev|test|prod> [plan|apply] [--allow-destroy]
#
# - Requiere el bucket del estado (scripts/floci/terraform-bootstrap.sh apply).
# - fmt -check, init con config/floci/backend.hcl, workspace <env>, validate y plan con
#   config/floci/target.tfvars + envs/<env>.tfvars; con `apply`, aplica ESE plan guardado.
# - El plan se rechaza si destruye o reemplaza recursos, salvo --allow-destroy (que solo
#   debe usarse con autorización expresa). Nunca ejecuta `terraform destroy`.
source "$(dirname "$0")/terraform-lib.sh"

ENV="${1:-}"; ACTION="${2:-plan}"; ALLOW_DESTROY="${3:-}"
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || die "Uso: $0 <dev|test|prod> [plan|apply] [--allow-destroy]"
[[ "$ACTION" =~ ^(plan|apply)$ ]] || die "Acción no válida: ${ACTION} (plan|apply)"
[[ -z "$ALLOW_DESTROY" || "$ALLOW_DESTROY" == --allow-destroy ]] || die "Opción desconocida: ${ALLOW_DESTROY}"
tf_guard

BUCKET="$(tf_state_bucket)"
aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 || die "No existe el bucket ${BUCKET}: scripts/floci/terraform-bootstrap.sh apply"
log_ok "Estado remoto: s3://${BUCKET} (versioning=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text))"
PLAN="${FLOCI_TMP_DIR}/live-${ENV}.tfplan"
mkdir -p "$FLOCI_TMP_DIR"
mapfile -t VARS < <(tf_var_args live "$ENV")

terraform fmt -check -recursive "$TF_ROOT" >/dev/null || die "terraform fmt: hay archivos sin formato (terraform fmt -recursive infra/terraform)"
tf_init live
tf live workspace select -or-create=true "$ENV" >/dev/null
[[ "$(tf live workspace show)" == "$ENV" ]] || die "No se pudo seleccionar el workspace ${ENV}"
log_ok "workspace: ${ENV}"
tf live validate >/dev/null && log_ok "validate"
tf live plan -input=false "${VARS[@]}" -out="$PLAN"
if [[ -z "$ALLOW_DESTROY" ]]; then
  tf_assert_no_destroy live "$PLAN" || die "Plan rechazado (destrucción o reemplazo). Revíselo; --allow-destroy solo con autorización."
fi

if [[ "$ACTION" == apply ]]; then
  tf live apply -input=false "$PLAN"
  log_ok "Estado: s3://${BUCKET}/env:/${ENV}/aegisvolt/terraform.tfstate"
fi
