#!/usr/bin/env bash
# Verifica que el runner puede ejecutar Floci con EKS (k3s) ANTES de iniciarlo (ADR-0035).
#
# Uso: scripts/ci/runner-preflight.sh [memoria mínima GiB] [disco libre mínimo GiB]
#
# Comprueba: socket de Docker utilizable, Docker Compose, memoria, CPU, disco libre en la
# raíz de Docker, creación de redes Docker (Floci crea los contenedores de EKS y ECR en
# la red aegisvolt-floci) y el puerto 4566 libre. Si algo falta, falla con el motivo:
# nunca se simula un resultado.
set -euo pipefail
MIN_MEM="${1:-8}"; MIN_DISK="${2:-12}"
fail() { echo "::error title=Runner sin capacidad::$1"; echo "PREFLIGHT FALLIDO: $1"; exit 1; }

[[ -S /var/run/docker.sock ]] || fail "No existe /var/run/docker.sock (Floci lo necesita para EKS y ECR)."
docker info >/dev/null 2>&1 || fail "Docker no responde en este runner."
docker compose version >/dev/null 2>&1 || fail "Falta Docker Compose v2."
mem_gib=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
cpus=$(nproc)
docker_root="$(docker info -f '{{.DockerRootDir}}')"
disk_gib=$(( $(df -Pk "$docker_root" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
(( mem_gib >= MIN_MEM )) || fail "Memoria ${mem_gib} GiB < ${MIN_MEM} GiB."
(( disk_gib >= MIN_DISK )) || fail "Disco libre en ${docker_root}: ${disk_gib} GiB < ${MIN_DISK} GiB."
net="preflight-$$"
docker network create "$net" >/dev/null 2>&1 || fail "No se pueden crear redes Docker."
docker network rm "$net" >/dev/null
if ss -ltn 2>/dev/null | grep -qE '[:.]4566 '; then fail "El puerto 4566 ya está en uso."; fi
echo "Runner OK: ${cpus} CPU, ${mem_gib} GiB RAM, ${disk_gib} GiB libres en ${docker_root}, Docker $(docker version -f '{{.Server.Version}}'), $(docker compose version --short)"
