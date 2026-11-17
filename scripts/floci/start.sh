#!/usr/bin/env bash
# Inicia Floci (idempotente). No borra ni reinicializa datos.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker
require_cmd curl
ensure_usable_docker_config
export_compose_env

mkdir -p "${FLOCI_DATA_DIR}"
[[ -w "${FLOCI_DATA_DIR}" ]] || die "${FLOCI_DATA_DIR} no es escribible por $(id -un)."

if floci_is_healthy && [[ "$(docker inspect -f '{{.State.Running}}' "${FLOCI_CONTAINER}" 2>/dev/null)" == "true" ]]; then
  log_ok "Floci ya está en ejecución en ${FLOCI_ENDPOINT}."
  exit 0
fi

if ss -ltn 2>/dev/null | grep -q '127.0.0.1:4566 \|0.0.0.0:4566 \|\[::\]:4566 \|\*:4566 '; then
  if [[ "$(docker inspect -f '{{.State.Running}}' "${FLOCI_CONTAINER}" 2>/dev/null)" != "true" ]]; then
    die "El puerto 4566 está ocupado por otro proceso. Libéralo antes de iniciar Floci."
  fi
fi

log_info "Iniciando Floci (${FLOCI_COMPOSE_FILE})..."
compose up -d

log_info "Esperando ${FLOCI_HEALTH_URL} ..."
if ! wait_for_floci 120; then
  compose logs --tail 50 floci >&2 || true
  die "Floci no respondió healthy en 120s."
fi

log_ok "Floci listo en ${FLOCI_ENDPOINT}"
curl -fsS "${FLOCI_HEALTH_URL}"; echo
echo
echo "Para usar AWS CLI contra Floci en esta shell:"
echo "  set -a; source infra/local/floci/config/aws-local.env; set +a"
