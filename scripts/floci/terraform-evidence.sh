#!/usr/bin/env bash
# Evidencias de Terraform en Floci (ADR-0033, §2.4 y §6.1). Requiere los tres ambientes
# aplicados (scripts/floci/terraform-live.sh <env> apply).
#
# Uso: scripts/floci/terraform-evidence.sh
#
# Demuestra, contra Floci y el bucket de estado real:
#   1. workspaces y claves S3 que genera el backend (env:/<ws>/aegisvolt/terraform.tfstate);
#   2. estados separados: cada estado solo contiene recursos con su ambiente en el nombre;
#   3. nombres sin colisión entre dev, test y prod (tablas, VPC, log groups, roles, APIs);
#   4. un apply en test crea una versión nueva SOLO del estado de test (dev y prod intactos);
#      el cambio es inocuo (umbral de una alarma de test) y se revierte;
#   5. versionado: historial del estado de dev y lectura de una versión anterior;
#   6. bloqueo nativo (use_lockfile): un segundo proceso no obtiene el lock;
#   7. guardas: workspace/tfvars cruzados, endpoint no local y cuenta no permitida.
# Escribe el informe en infra/local/floci/.tmp/terraform-evidence.md. Nunca ejecuta destroy.
source "$(dirname "$0")/terraform-lib.sh"
tf_guard

BUCKET="$(tf_state_bucket)"
OUT="${FLOCI_TMP_DIR}/terraform-evidence.md"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ENVS=(dev test prod)
REPORT=()
FAILED=0
say() { REPORT+=("$*"); }
check() { # <ok|fail> <texto>
  if [[ "$1" == ok ]]; then say "- ✅ $2"; log_ok "$2"; else say "- ❌ $2"; log_error "$2"; FAILED=1; fi
}
state_key() { echo "env:/$1/aegisvolt/terraform.tfstate"; }
latest_version() { aws s3api list-object-versions --bucket "$BUCKET" --prefix "$(state_key "$1")" \
  --query "Versions[?Key=='$(state_key "$1")' && IsLatest].VersionId | [0]" --output text; }

tf_init live
say "# Evidencias de Terraform en Floci — $(date -u +%FT%TZ)"
say ""
say "Terraform $(terraform version -json | jq -r .terraform_version), provider hashicorp/aws $(grep -m1 'version *=' "${TF_ROOT}/live/.terraform.lock.hcl" | sed 's/.*"\(.*\)"/\1/'), bucket \`${BUCKET}\`."

# --- 1. Workspaces y claves -----------------------------------------------------------------
say ""; say "## 1. Workspaces y claves del backend"; say ""
say '```text'; say "$(tf live workspace list)"; say '```'
say '```text'
say "$(aws s3api list-objects-v2 --bucket "$BUCKET" --query 'Contents[].[Key,Size]' --output text | sort)"
say '```'
for e in "${ENVS[@]}"; do
  aws s3api head-object --bucket "$BUCKET" --key "$(state_key "$e")" >/dev/null 2>&1 \
    && check ok "Estado de ${e} en s3://${BUCKET}/$(state_key "$e")" || check fail "Falta $(state_key "$e")"
done

# --- 2. Estados separados ---------------------------------------------------------------------
say ""; say "## 2. Cada estado solo contiene su ambiente"; say ""
say "| Workspace | Recursos gestionados | Lineage | Nombres con otro ambiente |"
say "| --- | --- | --- | --- |"
for e in "${ENVS[@]}"; do
  aws s3 cp "s3://${BUCKET}/$(state_key "$e")" "${WORK}/${e}.tfstate" >/dev/null
  n="$(jq '[.resources[] | select(.mode=="managed")] | length' "${WORK}/${e}.tfstate")"
  # Nombres con ambiente (tablas, VPC, roles, APIs, log groups, clúster) que NO son de este ambiente.
  foreign="$(jq -r --arg e "$e" '
    [.resources[] | select(.mode=="managed") | .instances[].attributes
     | (.name // .bucket // .cluster_name // .alarm_name // .dashboard_name // empty) | tostring
     | select(test("(^|[-/])(dev|test|prod)($|[-/])")) | select(test("(^|[-/])" + $e + "($|[-/])") | not)]
    | unique | join(", ")' "${WORK}/${e}.tfstate")"
  say "| ${e} | ${n} | \`$(jq -r .lineage "${WORK}/${e}.tfstate")\` | ${foreign:-ninguno} |"
  [[ -z "$foreign" ]] && check ok "El estado de ${e} no referencia recursos de otro ambiente" \
    || check fail "El estado de ${e} referencia: ${foreign}"
done
lineages="$(for e in "${ENVS[@]}"; do jq -r .lineage "${WORK}/${e}.tfstate"; done | sort -u | wc -l)"
[[ "$lineages" == 3 ]] && check ok "Tres estados independientes (3 lineages distintos)" || check fail "Lineages compartidos"

# --- 3. Nombres sin colisión ------------------------------------------------------------------
say ""; say "## 3. Nombres por ambiente (AWS CLI contra Floci)"; say ""
say "| Recurso | dev | test | prod |"; say "| --- | --- | --- | --- |"
row() { # <etiqueta> <comando que imprime nombres para el ambiente $1>
  local label="$1"; shift; local cells=()
  for e in "${ENVS[@]}"; do cells+=("$("$@" "$e" | sort | paste -sd' ' | sed 's/ /<br>/g')"); done
  say "| ${label} | ${cells[0]} | ${cells[1]} | ${cells[2]} |"
}
tables_of() { aws dynamodb list-tables --output text --query 'TableNames' | tr '\t' '\n' | grep -E "^aegisvolt-.*-$1$"; }
vpc_of() { aws ec2 describe-vpcs --filters "Name=tag:Name,Values=aegisvolt-$1" --query 'Vpcs[].[CidrBlock]' --output text; }
apis_of() { aws apigateway get-rest-apis --query "items[?starts_with(name,'aegisvolt-$1-')].name" --output text | tr '\t' '\n'; }
eks_of() { aws eks list-clusters --query "clusters[?@=='aegisvolt-$1']" --output text; }
row "Tablas DynamoDB" tables_of
row "VPC (CIDR)" vpc_of
row "APIs REST" apis_of
row "Clúster EKS" eks_of
all_tables="$(for e in "${ENVS[@]}"; do tables_of "$e"; done)"
[[ "$(sort <<<"$all_tables" | uniq -d)" == "" && "$(wc -l <<<"$all_tables")" -ge 15 ]] \
  && check ok "15 tablas (5 por ambiente), ningún nombre repetido" || check fail "Colisión o faltan tablas"
[[ "$(for e in "${ENVS[@]}"; do vpc_of "$e"; done | sort | uniq -d)" == "" ]] && check ok "CIDRs de VPC distintos por ambiente" || check fail "CIDRs repetidos"

# --- 4. Un apply en test no escribe los estados de dev ni prod --------------------------------------
say ""; say "## 4. Aislamiento de escritura: apply en test"; say ""
declare -A BEFORE AFTER
for e in "${ENVS[@]}"; do BEFORE[$e]="$(latest_version "$e")"; done
mapfile -t VARS_TEST < <(tf_var_args live test)
tf live workspace select test >/dev/null
change='observability={retention_in_days=14,service_error_threshold=6}'
tf live apply -input=false -auto-approve "${VARS_TEST[@]}" -var "$change" >"${WORK}/apply-test.log" 2>&1 \
  || { tail -20 "${WORK}/apply-test.log"; die "apply de test falló"; }
for e in "${ENVS[@]}"; do AFTER[$e]="$(latest_version "$e")"; done
say "Cambio inocuo en test: umbral de las alarmas de errores 5 → 6 ($(grep -o 'Resources: .*' "${WORK}/apply-test.log"))."
say ""; say "| Estado | Versión antes | Versión después |"; say "| --- | --- | --- |"
for e in "${ENVS[@]}"; do say "| ${e} | \`${BEFORE[$e]}\` | \`${AFTER[$e]}\` |"; done
[[ "${BEFORE[test]}" != "${AFTER[test]}" ]] && check ok "test: versión nueva del estado" || check fail "test no escribió estado"
[[ "${BEFORE[dev]}" == "${AFTER[dev]}" && "${BEFORE[prod]}" == "${AFTER[prod]}" ]] \
  && check ok "dev y prod: misma versión del estado (no se escribieron)" || check fail "Se modificó el estado de dev o prod"
thr() { aws cloudwatch describe-alarms --alarm-names "aegisvolt-$1-graphql-api-errors" --query 'MetricAlarms[0].Threshold' --output text 2>/dev/null; }
say "Umbral en CloudWatch tras el apply: dev=$(thr dev), test=$(thr test), prod=$(thr prod)."
tf live apply -input=false -auto-approve "${VARS_TEST[@]}" >"${WORK}/revert-test.log" 2>&1 || die "No se pudo revertir test"
say "Revertido con un segundo apply de test (umbral $(thr test))."

# --- 5. Versionado del estado -----------------------------------------------------------------
say ""; say "## 5. Versionado del estado de dev"; say ""
say '```text'
say "$(aws s3api list-object-versions --bucket "$BUCKET" --prefix "$(state_key dev)" \
  --query "Versions[?Key=='$(state_key dev)'] | sort_by(@, &LastModified)[].[VersionId,LastModified,Size,IsLatest]" --output text)"
say '```'
nver="$(aws s3api list-object-versions --bucket "$BUCKET" --prefix "$(state_key dev)" --query "length(Versions[?Key=='$(state_key dev)'])" --output text)"
[[ "$nver" -ge 2 ]] && check ok "${nver} versiones del estado de dev" || check fail "Sin historial (${nver})"
prev="$(aws s3api list-object-versions --bucket "$BUCKET" --prefix "$(state_key dev)" \
  --query "Versions[?Key=='$(state_key dev)' && !IsLatest] | sort_by(@, &LastModified)[-1].VersionId" --output text)"
aws s3api get-object --bucket "$BUCKET" --key "$(state_key dev)" --version-id "$prev" "${WORK}/dev-prev.tfstate" >/dev/null
cur_serial="$(jq .serial "${WORK}/dev.tfstate")"; prev_serial="$(jq .serial "${WORK}/dev-prev.tfstate")"
say "Versión anterior \`${prev}\`: serial ${prev_serial} (actual ${cur_serial}), $(jq '[.resources[]|select(.mode=="managed")]|length' "${WORK}/dev-prev.tfstate") recursos, mismo lineage: $([[ "$(jq -r .lineage "${WORK}/dev-prev.tfstate")" == "$(jq -r .lineage "${WORK}/dev.tfstate")" ]] && echo sí || echo no)."
tf live show -json "${WORK}/dev-prev.tfstate" >/dev/null 2>&1 \
  && check ok "La versión anterior es un estado válido (terraform show) y recuperable" || check fail "Versión anterior ilegible"

# --- 6. Bloqueo nativo -----------------------------------------------------------------------------
say ""; say "## 6. Bloqueo del estado (use_lockfile)"; say ""
tf live workspace select test >/dev/null
TF_DATA_DIR="${WORK}/tfdata-a" tf live init -input=false -backend-config="config/${TF_TARGET}/backend.hcl" >/dev/null
TF_DATA_DIR="${WORK}/tfdata-b" tf live init -input=false -backend-config="config/${TF_TARGET}/backend.hcl" >/dev/null
# Proceso A: plan de test (mantiene el lock mientras refresca).
TF_DATA_DIR="${WORK}/tfdata-a" TF_WORKSPACE=test tf live plan -input=false "${VARS_TEST[@]}" -lock-timeout=0s >"${WORK}/lock-a.log" 2>&1 &
PID_A=$!
for _ in $(seq 1 40); do aws s3api head-object --bucket "$BUCKET" --key "$(state_key test).tflock" >/dev/null 2>&1 && break; sleep 0.25; done
lockinfo="$(aws s3 cp "s3://${BUCKET}/$(state_key test).tflock" - 2>/dev/null | jq -c '{ID,Operation,Who,Path}' 2>/dev/null || echo '(no visible)')"
# Proceso B: mismo workspace, sin espera.
TF_DATA_DIR="${WORK}/tfdata-b" TF_WORKSPACE=test tf live plan -input=false "${VARS_TEST[@]}" -lock-timeout=0s >"${WORK}/lock-b.log" 2>&1 && B_EXIT=0 || B_EXIT=$?
wait "$PID_A" && A_EXIT=0 || A_EXIT=$?
say "Lock tomado por A en \`$(state_key test).tflock\`: \`${lockinfo}\`"
say '```text'; say "$(sed 's/\x1b\[[0-9;]*m//g' "${WORK}/lock-b.log" | grep -A6 'Error acquiring the state lock' | head -8)"; say '```'
[[ "$A_EXIT" == 0 && "$B_EXIT" != 0 ]] && grep -q 'Error acquiring the state lock' "${WORK}/lock-b.log" \
  && check ok "El segundo proceso no obtuvo el lock (exit ${B_EXIT}); el primero terminó bien" \
  || check fail "Contención de lock no demostrada (A=${A_EXIT}, B=${B_EXIT})"
aws s3api head-object --bucket "$BUCKET" --key "$(state_key test).tflock" >/dev/null 2>&1 \
  && check fail "El .tflock quedó huérfano" || check ok "El lock se liberó al terminar (sin .tflock)"

# --- 7. Guardas ----------------------------------------------------------------------------------------
say ""; say "## 7. Guardas"; say ""
expect_fail() { # <descripción> <patrón esperado> <args de plan…>
  local d="$1" pat="$2"; shift 2
  if tf live plan -no-color -input=false "$@" >"${WORK}/guard.log" 2>&1; then check fail "${d}: el plan NO falló"
  elif grep -q "$pat" "${WORK}/guard.log"; then check ok "${d}: rechazado («$(sed 's/\x1b\[[0-9;]*m//g' "${WORK}/guard.log" | grep -m1 -o "$pat.*" | cut -c1-110)»)"
  else check fail "${d}: falló por otra causa"; sed 's/\x1b\[[0-9;]*m//g' "${WORK}/guard.log" | grep -m3 Error >&2; fi
}
tf live workspace select test >/dev/null
expect_fail "envs/prod.tfvars en el workspace test" "no corresponde al workspace" -var-file="config/${TF_TARGET}/target.tfvars" -var-file=envs/prod.tfvars
expect_fail "Endpoint real de AWS" "var.floci_endpoint is" "${VARS_TEST[@]}" -var floci_endpoint=https://dynamodb.us-east-1.amazonaws.com
expect_fail "Cuenta no permitida" "allowed" "${VARS_TEST[@]}" -var 'allowed_account_ids=["123456789012"]'
tf live workspace select default >/dev/null
# En default, las validaciones de los módulos (environment ∈ dev|test|prod) fallan antes que la precondición.
expect_fail "Workspace default" 'var.environment is "default"' "${VARS_TEST[@]}"
tf live workspace select dev >/dev/null

printf '%s\n' "${REPORT[@]}" > "$OUT"
log_info "Informe: ${OUT}"
exit "$FAILED"
