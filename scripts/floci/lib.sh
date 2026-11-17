#!/usr/bin/env bash
# Funciones comunes para los scripts de Floci. Se carga con `source`.
# Ninguna función de este archivo elimina datos persistentes.

set -euo pipefail

FLOCI_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${FLOCI_SCRIPTS_DIR}/../.." && pwd)"
FLOCI_DIR="${REPO_ROOT}/infra/local/floci"
FLOCI_COMPOSE_FILE="${FLOCI_DIR}/docker-compose.yml"
FLOCI_DATA_DIR="${FLOCI_DIR}/data"
FLOCI_TMP_DIR="${FLOCI_DIR}/.tmp"
FLOCI_CONTAINER="aegisvolt-floci"
FLOCI_ENDPOINT="${FLOCI_ENDPOINT:-http://localhost:4566}"
FLOCI_HEALTH_URL="${FLOCI_ENDPOINT}/_floci/health"

if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_BLU=$'\e[34m'; C_RST=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

log_info()  { printf '%s[info]%s %s\n'  "$C_BLU" "$C_RST" "$*"; }
log_ok()    { printf '%s[ ok ]%s %s\n'  "$C_GRN" "$C_RST" "$*"; }
log_warn()  { printf '%s[warn]%s %s\n'  "$C_YLW" "$C_RST" "$*" >&2; }
log_error() { printf '%s[fail]%s %s\n'  "$C_RED" "$C_RST" "$*" >&2; }
die()       { log_error "$*"; exit 1; }

# require_cmd <cmd> [hint]
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Falta '$1' en PATH. ${2:-Ver infra/local/floci/README.md}"
}

require_docker() {
  require_cmd docker
  docker info >/dev/null 2>&1 || die "El daemon de Docker no responde (¿está iniciado? ¿usuario en el grupo docker?)."
  docker compose version >/dev/null 2>&1 || die "Falta el plugin 'docker compose' v2+."
}

# Si ~/.docker/config.json declara un credsStore cuyo helper no existe
# (p. ej. 'desktop' heredado de Docker Desktop), todos los pulls fallan.
# No se modifica la configuración del usuario: se usa un DOCKER_CONFIG
# aislado en .tmp/ solo para los procesos lanzados por estos scripts.
ensure_usable_docker_config() {
  local cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  [[ -f "$cfg" ]] || return 0
  local store
  store="$(sed -n 's/.*"credsStore"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -n1)"
  if [[ -n "$store" ]] && ! command -v "docker-credential-${store}" >/dev/null 2>&1; then
    log_warn "credsStore '${store}' en ${cfg} no tiene helper instalado; usando DOCKER_CONFIG aislado (${FLOCI_TMP_DIR}/docker-config)."
    mkdir -p "${FLOCI_TMP_DIR}/docker-config"
    [[ -f "${FLOCI_TMP_DIR}/docker-config/config.json" ]] || echo '{}' > "${FLOCI_TMP_DIR}/docker-config/config.json"
    export DOCKER_CONFIG="${FLOCI_TMP_DIR}/docker-config"
  fi
}

# Variables que docker-compose.yml necesita (UID/GID y ruta absoluta de datos).
export_compose_env() {
  FLOCI_UID="$(id -u)"; export FLOCI_UID
  FLOCI_GID="$(id -g)"; export FLOCI_GID
  DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)"; export DOCKER_SOCKET_GID
  export FLOCI_HOST_DATA_DIR="${FLOCI_DATA_DIR}"
}

compose() {
  docker compose -f "${FLOCI_COMPOSE_FILE}" "$@"
}

# Carga credenciales FICTICIAS y endpoint local para AWS CLI / SDK.
load_aws_local_env() {
  set -a
  # shellcheck source=/dev/null
  source "${FLOCI_DIR}/config/aws-local.env"
  set +a
  assert_local_endpoint
}

# Barrera de seguridad: nunca operar contra un endpoint que no sea local.
assert_local_endpoint() {
  case "${AWS_ENDPOINT_URL:-}" in
    http://localhost:*|http://127.0.0.1:*|http://localhost.floci.io:*) ;;
    *) die "AWS_ENDPOINT_URL='${AWS_ENDPOINT_URL:-<vacío>}' no es local. Abortando para no tocar AWS real." ;;
  esac
  [[ "${AWS_ACCESS_KEY_ID:-}" == "test" ]] || die "AWS_ACCESS_KEY_ID debe ser la credencial ficticia 'test'."
}

floci_is_healthy() {
  curl -fsS --max-time 3 "${FLOCI_HEALTH_URL}" >/dev/null 2>&1
}

# wait_for_floci [timeout_seconds]
wait_for_floci() {
  local timeout="${1:-90}" waited=0
  until floci_is_healthy; do
    (( waited >= timeout )) && return 1
    sleep 2; waited=$((waited + 2))
  done
}
