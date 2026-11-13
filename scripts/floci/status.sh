#!/usr/bin/env bash
# Muestra el estado de Floci: contenedor, health, versión, persistencia y contenedores hermanos.
# Solo lectura. Exit 0 si Floci está healthy, 1 en caso contrario.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_docker
require_cmd curl
require_cmd jq "Instala jq (ver infra/local/floci/README.md)."

state="$(docker inspect -f '{{.State.Status}} (desde {{.State.StartedAt}})' "${FLOCI_CONTAINER}" 2>/dev/null || echo "no existe")"
image="$(docker inspect -f '{{.Config.Image}}' "${FLOCI_CONTAINER}" 2>/dev/null || echo "-")"
echo "Contenedor : ${FLOCI_CONTAINER} -> ${state}"
echo "Imagen     : ${image}"
echo "Endpoint   : ${FLOCI_ENDPOINT}"

if floci_is_healthy; then
  health="$(curl -fsS "${FLOCI_HEALTH_URL}")"
  echo "Health     : OK"
  echo "Versión    : $(jq -r '.version' <<<"$health") ($(jq -r '.edition' <<<"$health"))"
  echo "Servicios  : $(jq '[.services[] | select(. == "running")] | length' <<<"$health") en estado running"
  for s in s3 dynamodb logs apigateway apigatewayv2 ecr eks ec2 iam sts; do
    printf '   %-13s %s\n' "$s" "$(jq -r --arg s "$s" '.services[$s] // "no listado"' <<<"$health")"
  done
  mode="$(docker logs "${FLOCI_CONTAINER}" 2>&1 | sed -n 's/.*Storage mode: \([a-z]*\).*/\1/p' | tail -n1)"
  echo "Storage    : ${mode:-desconocido} -> ${FLOCI_DATA_DIR} ($(du -sh "${FLOCI_DATA_DIR}" 2>/dev/null | cut -f1))"
else
  echo "Health     : NO RESPONDE (${FLOCI_HEALTH_URL})"
fi

siblings="$(docker ps -a --filter 'name=^floci-' --format '   {{.Names}}  {{.Image}}  {{.Status}}' || true)"
echo "Contenedores creados por Floci:"
echo "${siblings:-   (ninguno)}"

floci_is_healthy
