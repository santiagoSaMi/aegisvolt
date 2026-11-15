#!/usr/bin/env bash
# Terraform de AegisVolt (infra/terraform/live) contra Floci, por workspace.
#
# Uso: scripts/floci/terraform-live.sh <dev|test|prod> [plan|apply]   (por defecto: plan)
#
# - Aplica infra/terraform/bootstrap (bucket del estado, con versionado) si el
#   bucket no existe todavía. Su estado es local (infra/terraform/bootstrap/).
# - `live/`: init con backend.floci.hcl, workspace <env>, validate y plan; con
#   `apply`, aplica el plan guardado. Nunca ejecuta destroy.
# - Solo contra Floci: lib.sh aborta si el endpoint no es local o la clave no es ficticia.
source "$(dirname "$0")/lib.sh"

ENV="${1:-}"; ACTION="${2:-plan}"
[[ "$ENV" =~ ^(dev|test|prod)$ ]] || die "Uso: $0 <dev|test|prod> [plan|apply]"
[[ "$ACTION" =~ ^(plan|apply)$ ]] || die "Acción no válida: ${ACTION} (plan|apply)"

require_cmd terraform
require_cmd aws
load_aws_local_env
curl -fsS "$FLOCI_HEALTH_URL" >/dev/null || die "Floci no responde en ${FLOCI_ENDPOINT}"

TF_ROOT="${REPO_ROOT}/infra/terraform"
STATE_BUCKET="$(sed -n 's/^bucket *= *"\(.*\)"/\1/p' "${TF_ROOT}/live/backend.floci.hcl")"
PLAN="${FLOCI_TMP_DIR}/live-${ENV}.tfplan"
mkdir -p "$FLOCI_TMP_DIR"

if ! aws s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null 2>&1; then
  log_info "Bucket ${STATE_BUCKET} inexistente: aplicando infra/terraform/bootstrap"
  terraform -chdir="${TF_ROOT}/bootstrap" init -input=false >/dev/null
  terraform -chdir="${TF_ROOT}/bootstrap" apply -input=false -auto-approve
fi
log_ok "Estado remoto: s3://${STATE_BUCKET} (versioning=$(aws s3api get-bucket-versioning --bucket "$STATE_BUCKET" --query Status --output text))"

cd "${TF_ROOT}/live"
terraform fmt -check -recursive "${TF_ROOT}" >/dev/null || die "terraform fmt: hay archivos sin formato (terraform fmt -recursive infra/terraform)"
terraform init -input=false -reconfigure -backend-config=backend.floci.hcl >/dev/null
terraform workspace select -or-create=true "$ENV" >/dev/null
log_ok "workspace: $(terraform workspace show)"
terraform validate >/dev/null && log_ok "validate"
terraform plan -input=false -out="$PLAN"

if [[ "$ACTION" == apply ]]; then
  terraform apply -input=false "$PLAN"
  log_ok "Estado: s3://${STATE_BUCKET}/env:/${ENV}/aegisvolt/terraform.tfstate"
fi
