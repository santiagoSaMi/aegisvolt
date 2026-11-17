#!/usr/bin/env bash
# Detiene Floci SIN eliminar contenedor, red ni datos (equivale a `docker compose stop`).
# Nunca usa `down -v`. Los datos en infra/local/floci/data se conservan.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker
export_compose_env

state="$(docker inspect -f '{{.State.Status}}' "${FLOCI_CONTAINER}" 2>/dev/null || echo "absent")"
case "$state" in
  absent)  log_ok "Floci no existe (nada que detener)."; exit 0 ;;
  exited|created) log_ok "Floci ya está detenido."; exit 0 ;;
esac

log_info "Deteniendo Floci (SIGTERM, hasta 60s para volcar estado a disco)..."
compose stop floci
log_ok "Floci detenido. Datos conservados en ${FLOCI_DATA_DIR}."

# Contenedores hermanos creados por Floci (k3s de EKS, registry de ECR, etc.).
leftovers="$(docker ps --filter 'name=^floci-' --format '{{.Names}}' || true)"
if [[ -n "$leftovers" ]]; then
  log_warn "Siguen en ejecución contenedores creados por Floci (no se tocan):"
  printf '  %s\n' $leftovers >&2
fi
