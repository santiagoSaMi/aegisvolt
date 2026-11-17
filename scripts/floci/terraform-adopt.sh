#!/usr/bin/env bash
# Adopta en Terraform los recursos que existían antes de gestionarlos con Terraform
# (los crearon scripts con AWS CLI en fases anteriores). Sin recrearlos ni perder datos.
#
# Uso: scripts/floci/terraform-adopt.sh <global|dev|test|prod>
#
# Idempotente: importa solo lo que existe en Floci y aún no está en el estado. Luego
# hay que revisar el plan (terraform-live.sh / terraform-global.sh): no debe destruir
# ni reemplazar nada de lo importado.
#   global: repositorios ECR aegisvolt/<app> (con sus imágenes).
#   <env>:  tablas aegisvolt-<dominio>-<env> (con sus datos) y los ítems de flags
#           (con su valor ACTUAL, que Terraform no sobrescribe: ignore_changes).
source "$(dirname "$0")/terraform-lib.sh"

SCOPE="${1:-}"
[[ "$SCOPE" =~ ^(global|dev|test|prod)$ ]] || die "Uso: $0 <global|dev|test|prod>"
tf_guard

LOG="${FLOCI_TMP_DIR}/terraform-adopt-${SCOPE}-$(date -u +%Y%m%dT%H%M%SZ).log"
mkdir -p "$FLOCI_TMP_DIR"
IMPORTED=0

if [[ "$SCOPE" == global ]]; then
  ROOT=global
  tf_init global
  mapfile -t VARS < <(tf_var_args global)
else
  ROOT=live
  tf_init live
  tf live workspace select -or-create=true "$SCOPE" >/dev/null
  mapfile -t VARS < <(tf_var_args live "$SCOPE")
fi
STATE="$(tf "$ROOT" state list 2>/dev/null || true)"

adopt() { # <dirección> <id> <descripción>
  if grep -qxF "$1" <<<"$STATE"; then
    log_info "Ya gestionado: $1"
    return
  fi
  log_info "Importando $3 → $1"
  tf "$ROOT" import -input=false "${VARS[@]}" "$1" "$2" >>"$LOG" 2>&1 || die "Import fallido ($1). Ver ${LOG}"
  echo "$(date -u +%FT%TZ) imported $1 id=$2" >>"$LOG"
  IMPORTED=$((IMPORTED + 1))
}

if [[ "$SCOPE" == global ]]; then
  for app in $(aws ecr describe-repositories --query 'repositories[?starts_with(repositoryName, `aegisvolt/`)].repositoryName' --output text); do
    adopt "module.ecr.aws_ecr_repository.this[\"${app#aegisvolt/}\"]" "$app" "repositorio ECR ${app}"
  done
else
  for domain in reservations billing dispatch sagas feature-flags; do
    table="aegisvolt-${domain}-${SCOPE}"
    if aws dynamodb describe-table --table-name "$table" >/dev/null 2>&1; then
      adopt "module.tables[\"${domain}\"].aws_dynamodb_table.this" "$table" "tabla ${table} ($(aws dynamodb describe-table --table-name "$table" --query Table.ItemCount --output text) ítems)"
    fi
  done
  FLAGS_TABLE="aegisvolt-feature-flags-${SCOPE}"
  for key in $(jq -r '.flags[].key' "${TF_ROOT}/live/feature-flags.json"); do
    if aws dynamodb get-item --table-name "$FLAGS_TABLE" --key "{\"PK\":{\"S\":\"FLAG#${key}\"},\"SK\":{\"S\":\"META\"}}" \
         --query 'Item.PK.S' --output text 2>/dev/null | grep -q "FLAG#"; then
      adopt "aws_dynamodb_table_item.feature_flag[\"${key}\"]" "${FLAGS_TABLE},FLAG#${key},META" "flag ${key} de ${SCOPE}"
    fi
  done
fi

# `terraform import` guarda en el estado los data sources que lee. No tienen objeto
# remoto (se releen en cada plan), pero ocupan direcciones de módulo e impiden los
# bloques `moved` (p. ej. module.observability → module.cloudwatch). Se quitan.
for ds in $(tf "$ROOT" state list | grep -E '(^|\.)data\.' || true); do
  tf "$ROOT" state rm "$ds" >>"$LOG" 2>&1
done

log_ok "${SCOPE}: ${IMPORTED} recursos importados (registro: ${LOG})"
