#!/usr/bin/env bash
# Verifica la integración Terraform <-> Floci con una configuración mínima.
#
# Uso: scripts/floci/terraform-check.sh [--apply]
#   sin flags : fmt -check, init, workspace, validate, plan  (no crea recursos)
#   --apply   : además aplica el plan guardado (solo recursos aegisvolt-floci-check-*)
#
# Nunca ejecuta `terraform destroy`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true
[[ $# -gt 1 || ( $# -eq 1 && "$APPLY" == false ) ]] && die "Uso: $0 [--apply]"

require_cmd terraform; require_cmd aws; require_cmd jq
load_aws_local_env
floci_is_healthy || die "Floci no responde. Ejecuta scripts/floci/start.sh"

TF_DIR="${FLOCI_DIR}/terraform-check"
WORKSPACE="floci-check"
STATE_BUCKET="$(sed -n 's/^bucket *= *"\(.*\)"/\1/p' "${TF_DIR}/backend.floci.hcl")"
STATE_KEY="$(sed -n 's/^key *= *"\(.*\)"/\1/p' "${TF_DIR}/backend.floci.hcl")"
PLAN_FILE="${FLOCI_TMP_DIR}/terraform-check.tfplan"
mkdir -p "${FLOCI_TMP_DIR}"

# Barrera: todos los endpoints declarados deben ser locales.
if cat "${TF_DIR}"/*.tf "${TF_DIR}"/*.hcl | grep -vE '^[[:space:]]*#' \
   | grep -oE '=[[:space:]]*"https?://[^"]+"' | sed -E 's/^=[[:space:]]*"(.*)"$/\1/' | grep -vE '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$' | grep -q .; then
  die "Hay endpoints no locales en ${TF_DIR}. Abortando."
fi

# El bucket del estado no puede gestionarse con el mismo estado que guarda
# (problema del huevo y la gallina). Para esta verificación se crea con AWS CLI
# de forma idempotente; la fase de IaC lo reemplaza por un módulo bootstrap.
if ! aws s3api head-bucket --bucket "${STATE_BUCKET}" >/dev/null 2>&1; then
  log_info "Creando bucket de estado ${STATE_BUCKET} en Floci..."
  aws s3api create-bucket --bucket "${STATE_BUCKET}" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "${STATE_BUCKET}" --versioning-configuration Status=Enabled
log_ok "Bucket de estado ${STATE_BUCKET}: versioning=$(aws s3api get-bucket-versioning --bucket "${STATE_BUCKET}" --query Status --output text)"

cd "${TF_DIR}"
log_info "terraform fmt -check"; terraform fmt -check -diff
log_info "terraform init";       terraform init -input=false -reconfigure -backend-config=backend.floci.hcl >/dev/null
log_ok   "init OK (backend s3 -> Floci)"
terraform workspace select -or-create=true "${WORKSPACE}" >/dev/null
log_ok   "workspace: $(terraform workspace show)"
log_info "terraform validate";   terraform validate
log_info "terraform plan";       terraform plan -input=false -out="${PLAN_FILE}"

if $APPLY; then
  log_info "terraform apply (plan guardado)"
  terraform apply -input=false "${PLAN_FILE}"
  log_info "Verificación con AWS CLI:"
  aws dynamodb describe-table --table-name "aegisvolt-floci-check-${WORKSPACE}" --query 'Table.[TableName,TableStatus]' --output text
  aws logs describe-log-groups --log-group-name-prefix "/aegisvolt/${WORKSPACE}/" --query 'logGroups[].[logGroupName,retentionInDays]' --output text
fi

log_info "Objetos de estado en s3://${STATE_BUCKET}:"
aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
  --query 'Versions[].[Key,VersionId,IsLatest,LastModified]' --output text || true
log_ok "Estado esperado en: s3://${STATE_BUCKET}/env:/${WORKSPACE}/${STATE_KEY}"
