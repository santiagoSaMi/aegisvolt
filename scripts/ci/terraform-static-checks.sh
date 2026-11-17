#!/usr/bin/env bash
# Comprobaciones de Terraform que no necesitan Floci (check `terraform-validate`, ADR-0035):
#   fmt -check, init sin backend + validate de bootstrap, global y live, ningún endpoint
#   no local escrito en la configuración y provider fijado en los lock files.
set -euo pipefail
TF="$(cd "$(dirname "$0")/../../infra/terraform" && pwd)"
PROVIDER=6.71.0
terraform version
terraform fmt -check -recursive -diff "$TF"
echo "fmt OK"
for root in bootstrap global live; do
  terraform -chdir="${TF}/${root}" init -backend=false -input=false -lockfile=readonly >/dev/null
  if [[ "$root" == live ]]; then
    # live deriva el ambiente de terraform.workspace: en un init limpio es `default`, que las
    # validaciones de los módulos rechazan (con razón). Se valida en cada workspace real.
    for ws in dev test prod; do
      echo "live (workspace ${ws}):"
      TF_WORKSPACE="$ws" terraform -chdir="${TF}/${root}" validate -no-color
    done
  else
    terraform -chdir="${TF}/${root}" validate -no-color
  fi
  grep -q "version *= *\"${PROVIDER}\"" "${TF}/${root}/.terraform.lock.hcl" \
    || { echo "::error::${root}/.terraform.lock.hcl no fija hashicorp/aws ${PROVIDER}"; exit 1; }
done
# Misma barrera que scripts/floci/terraform-lib.sh: solo URLs locales en la configuración.
bad="$(grep -rnE --include='*.tf' --include='*.hcl' --include='*.tfvars' '"https?://' "$TF" \
  | grep -v '/\.terraform/' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' | grep -v '\${' \
  | grep -vE '"https?://(localhost|127\.0\.0\.1)(:[0-9]+)?"' || true)"
if [[ -n "$bad" ]]; then echo "::error::Endpoints no locales en Terraform:"; echo "$bad"; exit 1; fi
echo "Sin endpoints no locales; provider hashicorp/aws ${PROVIDER} fijado en las tres raíces."
