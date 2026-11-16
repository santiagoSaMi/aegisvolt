#!/usr/bin/env bash
# Prepara en Floci los datos de infraestructura de un ambiente para ejecutar las
# imágenes (docker compose o Kubernetes). Idempotente: se puede repetir.
#
# Uso: scripts/floci/bootstrap-env.sh <local|dev|test|prod>
#
# - local: crea si faltan las tablas aegisvolt-{reservations,billing,dispatch,sagas}-local y
#   aegisvolt-feature-flags-local (con el valor inicial de cada flag).
# - dev/test/prod: comprueba que existan (las crea Terraform, ADR-0033).
# Crea si faltan:
#   - User Pool aegisvolt-<env> (atributo custom:fleet_id), app client público, grupos
#     fleet-operators/platform-admins y dos usuarios de demostración.
# Escribe infra/local/floci/.tmp/identity-<env>.env (0600) con el pool, el client y la
# contraseña FICTICIA de los usuarios de demostración. Cognito sigue fuera de Terraform (L-13).
source "$(dirname "$0")/lib.sh"

ENV="${1:-}"
[[ "$ENV" =~ ^(local|dev|test|prod)$ ]] || die "Uso: $0 <local|dev|test|prod>"
require_cmd aws
require_cmd jq
load_aws_local_env
curl -fsS "$FLOCI_HEALTH_URL" >/dev/null || die "Floci no responde en ${FLOCI_ENDPOINT}"
mkdir -p "$FLOCI_TMP_DIR"
IDENTITY_FILE="${FLOCI_TMP_DIR}/identity-${ENV}.env"

# --- DynamoDB: scripts de cada servicio (definición de tabla del propio servicio) ---
# shellcheck source=/dev/null
source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true
declare -A TABLES=(
  [station-reservation]="aegisvolt-reservations-${ENV}"
  [billing-wallet]="aegisvolt-billing-${ENV}"
  [energy-dispatch]="aegisvolt-dispatch-${ENV}"
  [saga-orchestrator]="aegisvolt-sagas-${ENV}"
)
if [[ "$ENV" == local ]]; then
  # Ambiente local (docker compose): fuera de Terraform; tablas con el script de cada servicio.
  for service in "${!TABLES[@]}"; do
    (cd "${REPO_ROOT}/services/${service}" && DYNAMODB_TABLE_NAME="${TABLES[$service]}" node scripts/create-local-table.ts) | sed 's/^/  /'
  done
  (cd "${REPO_ROOT}/packages/feature-flags" && node scripts/create-local-table.ts "$ENV") | sed 's/^/  /'
else
  # dev/test/prod: las tablas y la semilla de flags son de Terraform (ADR-0033).
  for table in "${TABLES[@]}" "aegisvolt-feature-flags-${ENV}"; do
    aws dynamodb describe-table --table-name "$table" >/dev/null 2>&1 \
      || die "No existe la tabla ${table}: scripts/floci/terraform-live.sh ${ENV} apply"
  done
fi
log_ok "Tablas de ${ENV} listas"

# --- Cognito ----------------------------------------------------------------------------
POOL_NAME="aegisvolt-${ENV}"
POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)"
if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
  POOL_ID="$(aws cognito-idp create-user-pool --pool-name "$POOL_NAME" \
    --schema Name=fleet_id,AttributeDataType=String,Mutable=true --query UserPool.Id --output text)"
  log_ok "User Pool ${POOL_NAME} creado (${POOL_ID})"
fi
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 \
  --query "UserPoolClients[?ClientName=='console'].ClientId | [0]" --output text)"
if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == "None" ]]; then
  CLIENT_ID="$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name console \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH --query UserPoolClient.ClientId --output text)"
fi
for group in fleet-operators platform-admins; do
  aws cognito-idp get-group --user-pool-id "$POOL_ID" --group-name "$group" >/dev/null 2>&1 \
    || aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name "$group" >/dev/null
done

# Contraseña ficticia de demostración: se genera una vez por ambiente y se reutiliza.
PASSWORD=""
[[ -f "$IDENTITY_FILE" ]] && PASSWORD="$(sed -n 's/^DEMO_PASSWORD=//p' "$IDENTITY_FILE")"
[[ -n "$PASSWORD" ]] || PASSWORD="Demo-$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 10)-1a!"
ensure_user() { # <usuario> <grupo> [fleet]
  if ! aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$1" >/dev/null 2>&1; then
    aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$1" --message-action SUPPRESS \
      ${3:+--user-attributes Name=custom:fleet_id,Value=$3} >/dev/null
  fi
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$1" --password "$PASSWORD" --permanent
  aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$1" --group-name "$2"
}
ensure_user operador fleet-operators fleet_demo
ensure_user admin platform-admins

umask 077
cat > "$IDENTITY_FILE" <<IDENT
# Generado por scripts/floci/bootstrap-env.sh ${ENV} (valores LOCALES y ficticios).
APP_ENV=${ENV}
COGNITO_POOL_ID=${POOL_ID}
COGNITO_CLIENT_ID=${CLIENT_ID}
COGNITO_ISSUER=https://floci:4566/${POOL_ID}
COGNITO_JWKS_URL=http://floci:4566/${POOL_ID}/.well-known/jwks.json
DEMO_USERS=operador,admin
DEMO_FLEET=fleet_demo
DEMO_PASSWORD=${PASSWORD}
IDENT
log_ok "Cognito ${POOL_NAME}: pool ${POOL_ID}, client ${CLIENT_ID}; usuarios operador (fleet_demo) y admin"
log_info "Identidad y contraseña de demostración: ${IDENTITY_FILE}"
