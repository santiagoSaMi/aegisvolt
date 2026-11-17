#!/usr/bin/env bash
# AegisVolt en docker compose integrado con Floci (infra/local/compose, ADR-0031).
#
# Uso: scripts/local/compose.sh <up|down|ps|logs|seed> [opciones de docker compose]
#   up    bootstrap del ambiente `local` en Floci, build (tag inmutable) y arranque
#   down  detiene y elimina los contenedores (los datos quedan en Floci)
#   seed  estaciones y billeteras de demostración (por las APIs de los servicios)
# Variable opcional: AEGISVOLT_TAG=<tag existente> para no reconstruir.
source "$(dirname "$0")/../floci/lib.sh"

CMD="${1:-}"; shift || true
COMPOSE_FILE="${REPO_ROOT}/infra/local/compose/docker-compose.yml"
IDENTITY="${FLOCI_TMP_DIR}/identity-local.env"
ensure_usable_docker_config

load_identity() {
  [[ -f "$IDENTITY" ]] || die "Falta ${IDENTITY}: ejecute 'scripts/local/compose.sh up'"
  set -a
  # shellcheck source=/dev/null
  source "$IDENTITY"
  set +a
  export AEGISVOLT_TAG="${AEGISVOLT_TAG:-$(cat "${FLOCI_TMP_DIR}/compose-tag" 2>/dev/null || echo unset)}"
}
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

case "$CMD" in
  up)
    curl -fsS "$FLOCI_HEALTH_URL" >/dev/null || die "Floci no responde: scripts/floci/start.sh"
    "${REPO_ROOT}/scripts/floci/bootstrap-env.sh" local
    if [[ -z "${AEGISVOLT_TAG:-}" ]]; then
      "${REPO_ROOT}/scripts/docker/build-images.sh" --tag-file "${FLOCI_TMP_DIR}/compose-tag" >/dev/null
      AEGISVOLT_TAG="$(cat "${FLOCI_TMP_DIR}/compose-tag")"
    fi
    echo "$AEGISVOLT_TAG" > "${FLOCI_TMP_DIR}/compose-tag"
    load_identity
    dc up --detach --wait --wait-timeout 180 "$@"
    dc ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
    log_ok "Consola: http://127.0.0.1:8080 · GraphQL: http://127.0.0.1:4000/graphql · imágenes ${AEGISVOLT_TAG}"
    log_info "Usuarios operador/admin; contraseña en ${IDENTITY}"
    ;;
  down) load_identity; dc down "$@" ;;
  ps) load_identity; dc ps "$@" ;;
  logs) load_identity; dc logs "$@" ;;
  seed)
    load_identity
    for s in st_demo-bogota-01:bogota:4.65:-74.06 st_demo-medellin-01:medellin:6.21:-75.57; do
      IFS=: read -r id city lat lon <<<"$s"
      curl -fsS -X PUT "http://127.0.0.1:4101/v1/stations/${id}" -H 'content-type: application/json' \
        -d "{\"name\":\"Estación ${city}\",\"city\":\"${city}\",\"location\":{\"latitude\":${lat},\"longitude\":${lon}},\"connectors\":[{\"connectorId\":\"cn_01\",\"type\":\"CCS2\",\"maxPowerKw\":60},{\"connectorId\":\"cn_02\",\"type\":\"TYPE2\",\"maxPowerKw\":22}]}" \
        -o /dev/null -w "estación ${id}: HTTP %{http_code}\n"
    done
    curl -fsS -X PUT "http://127.0.0.1:4102/v1/wallets/${DEMO_FLEET}" -H 'content-type: application/json' -d '{}' -o /dev/null -w "billetera ${DEMO_FLEET}: HTTP %{http_code}\n" || true
    curl -fsS -X PUT "http://127.0.0.1:4102/v1/wallets/${DEMO_FLEET}/top-ups/tup_demo-$(date +%s)" -H 'content-type: application/json' \
      -d '{"amount":{"amountMinor":50000000,"currency":"COP"}}' -o /dev/null -w "recarga: HTTP %{http_code}\n"
    ;;
  *) die "Uso: $0 <up|down|ps|logs|seed>" ;;
esac
