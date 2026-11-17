#!/usr/bin/env bash
# Funciones comunes de los scripts de Terraform contra Floci (ADR-0033).
# Uso: source "$(dirname "$0")/terraform-lib.sh"   (incluye lib.sh)
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TF_ROOT="${REPO_ROOT}/infra/terraform"
TF_TARGET="floci"   # único destino admitido por los scripts (CLAUDE.md: nunca AWS real)

# Barreras previas a cualquier comando de Terraform:
# - credenciales ficticias y endpoint local (lib.sh), sin ~/.aws ni perfiles;
# - Floci en marcha;
# - ningún endpoint no local escrito en la configuración de Terraform.
tf_guard() {
  require_cmd terraform
  require_cmd aws
  require_cmd jq
  load_aws_local_env
  unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE
  export TF_IN_AUTOMATION=1 TF_INPUT=0
  floci_is_healthy || die "Floci no responde en ${FLOCI_ENDPOINT}. Ejecuta scripts/floci/start.sh"
  local bad
  bad="$(grep -rnE --include='*.tf' --include='*.hcl' --include='*.tfvars' '"https?://' "$TF_ROOT" \
    | grep -v '/\.terraform/' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' | grep -v '\${' \
    | grep -vE '"https?://(localhost|127\.0\.0\.1)(:[0-9]+)?"' || true)"
  [[ -z "$bad" ]] || die "Endpoints no locales en la configuración de Terraform:\n${bad}"
  [[ "$(terraform version -json | jq -r .terraform_version)" == 1.17.1 ]] \
    || log_warn "Terraform $(terraform version -json | jq -r .terraform_version): la versión verificada es 1.17.1 (ADR-0033)"
}

# tf <raíz> <args…>: terraform en infra/terraform/<raíz>.
tf() { local root="$1"; shift; terraform -chdir="${TF_ROOT}/${root}" "$@"; }

# Args de variables del destino (y del ambiente, si se indica).
tf_var_args() { # <raíz> [env]
  local args=(-var-file="config/${TF_TARGET}/target.tfvars")
  [[ -n "${2:-}" ]] && args+=(-var-file="envs/${2}.tfvars")
  printf '%s\n' "${args[@]}"
}

tf_init() { # <raíz>
  tf "$1" init -input=false -reconfigure -backend-config="config/${TF_TARGET}/backend.hcl" >/dev/null \
    || die "terraform init ($1) falló"
}

tf_state_bucket() { sed -n 's/^bucket *= *"\(.*\)"/\1/p' "${TF_ROOT}/bootstrap/config/${TF_TARGET}/backend.hcl"; }

# Falla si un plan guardado destruye o reemplaza algún recurso (salvo que se permita).
tf_assert_no_destroy() { # <raíz> <plan>
  local destroys
  destroys="$(tf "$1" show -json "$2" | jq -r '.resource_changes[]? | select(.change.actions | index("delete")) | "\(.address) \(.change.actions | join("/"))"')"
  if [[ -n "$destroys" ]]; then
    log_error "El plan destruye o reemplaza recursos:"; echo "$destroys" >&2
    return 1
  fi
}
