#!/usr/bin/env bash
# Terraform de los recursos compartidos (infra/terraform/global) contra Floci.
#
# Uso: scripts/floci/terraform-global.sh [plan|apply]   (por defecto: plan)
# Estado: s3://aegisvolt-tfstate/global/terraform.tfstate (sin workspaces).
# El plan se rechaza si destruye o reemplaza algún recurso. Nunca ejecuta destroy.
source "$(dirname "$0")/terraform-lib.sh"

ACTION="${1:-plan}"
[[ "$ACTION" =~ ^(plan|apply)$ ]] || die "Uso: $0 [plan|apply]"
tf_guard
PLAN="${FLOCI_TMP_DIR}/global.tfplan"
mapfile -t VARS < <(tf_var_args global)

terraform fmt -check -recursive "$TF_ROOT" >/dev/null || die "terraform fmt: hay archivos sin formato (terraform fmt -recursive infra/terraform)"
tf_init global
tf global validate >/dev/null && log_ok "validate"
tf global plan -input=false "${VARS[@]}" -out="$PLAN"
tf_assert_no_destroy global "$PLAN" || die "Plan rechazado"
[[ "$ACTION" == apply ]] && tf global apply -input=false "$PLAN"
log_ok "Estado: s3://$(tf_state_bucket)/global/terraform.tfstate"
