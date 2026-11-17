#!/usr/bin/env bash
# Bootstrap del estado remoto en Floci (ADR-0011, ADR-0033).
#
# Uso: scripts/floci/terraform-bootstrap.sh [plan|apply]   (por defecto: plan)
#
# Resuelve el problema del huevo y la gallina en tres casos:
#   1. El estado de bootstrap ya está en S3 (bootstrap/terraform.tfstate): init + plan/apply.
#   2. Hay un estado LOCAL (infra/terraform/bootstrap/terraform.tfstate): migración
#      controlada al bucket (respaldo, init -migrate-state, comparación de recursos,
#      serial y lineage). El archivo local queda como respaldo hasta revisarlo.
#   3. No existe el bucket: apply con backend local temporal (backend_override.tf) y
#      después la migración del caso 2.
# Nunca ejecuta destroy.
source "$(dirname "$0")/terraform-lib.sh"

ACTION="${1:-plan}"
[[ "$ACTION" =~ ^(plan|apply)$ ]] || die "Uso: $0 [plan|apply]"
tf_guard

DIR="${TF_ROOT}/bootstrap"
BUCKET="$(tf_state_bucket)"
KEY="$(sed -n 's/^key *= *"\(.*\)"/\1/p' "${DIR}/config/${TF_TARGET}/backend.hcl")"
BACKUP_DIR="${FLOCI_TMP_DIR}/tfstate-backups"
PLAN="${FLOCI_TMP_DIR}/bootstrap.tfplan"
mapfile -t VARS < <(tf_var_args bootstrap)
mkdir -p "$BACKUP_DIR"

remote_state_exists() { aws s3api head-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1; }

migrate_local_state() {
  local local_state="${DIR}/terraform.tfstate" backup
  backup="${BACKUP_DIR}/bootstrap-local-$(date -u +%Y%m%dT%H%M%SZ).tfstate"
  cp "$local_state" "$backup"
  log_info "Respaldo del estado local: ${backup}"
  # Se compara el CONTENIDO (recursos con sus atributos y outputs). Al copiar un estado
  # local a un backend vacío, Terraform escribe una instantánea nueva (lineage propio,
  # serial 1): se informa, pero no es pérdida de información.
  local content='{resources: .resources, outputs: .outputs}'
  local before; before="$(jq -S -c "$content" "$local_state" | sha256sum | cut -c1-16)"

  log_info "Migrando el estado local a s3://${BUCKET}/${KEY}"
  tf bootstrap init -input=false -migrate-state -force-copy -backend-config="config/${TF_TARGET}/backend.hcl" >/dev/null \
    || die "La migración falló; el estado local sigue intacto en ${local_state} (y ${backup})"

  local after
  after="$(aws s3 cp "s3://${BUCKET}/${KEY}" - | jq -S -c "$content" | sha256sum | cut -c1-16)"
  [[ "$before" == "$after" ]] || die "El contenido del estado remoto (${after}) no coincide con el local (${before}). Respaldo: ${backup}"
  log_ok "Estado migrado sin pérdida: recursos y outputs idénticos (sha256 ${after}); $(jq -r '"\(.resources | length) recursos, lineage local \(.lineage), serial \(.serial)"' "$backup")"
  # Terraform vacía el archivo local tras copiarlo (y deja terraform.tfstate.backup);
  # se renombra para que nadie lo use por error.
  [[ -f "$local_state" ]] && mv "$local_state" "${local_state}.migrated"
}

if remote_state_exists; then
  log_ok "Estado de bootstrap en s3://${BUCKET}/${KEY}"
  tf_init bootstrap
elif [[ -f "${DIR}/terraform.tfstate" ]]; then
  migrate_local_state
elif aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  die "El bucket ${BUCKET} existe pero no hay estado de bootstrap (ni local ni remoto). Impórtelo con terraform import antes de continuar."
else
  log_info "Bucket ${BUCKET} inexistente: primer apply con backend local temporal"
  OVERRIDE="${DIR}/backend_override.tf"
  trap 'rm -f "$OVERRIDE"' EXIT
  printf '# Temporal (terraform-bootstrap.sh): backend local solo para el primer apply.\nterraform {\n  backend "local" {}\n}\n' > "$OVERRIDE"
  tf bootstrap init -input=false -reconfigure >/dev/null
  tf bootstrap apply -input=false -auto-approve "${VARS[@]}"
  rm -f "$OVERRIDE"
  migrate_local_state
fi

tf bootstrap validate >/dev/null && log_ok "validate"
tf bootstrap plan -input=false "${VARS[@]}" -out="$PLAN"
tf_assert_no_destroy bootstrap "$PLAN" || die "Plan rechazado"
if [[ "$ACTION" == apply ]]; then
  tf bootstrap apply -input=false "$PLAN"
fi
log_ok "Bucket: versioning=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)"
