#!/usr/bin/env bash
# Libera espacio en un runner HOSPEDADO por GitHub (14 GB de SSD libres según la
# documentación) borrando toolchains preinstalados que AegisVolt no usa. Las imágenes de
# las 6 unidades, Floci, k3s y las mismas imágenes dentro de k3s no caben de otro modo.
# Se niega a ejecutarse fuera de GitHub Actions hospedado.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
  || { echo "free-runner-disk.sh solo se ejecuta en runners hospedados de GitHub." >&2; exit 1; }
before=$(df -Pk / | awk 'NR==2 {print int($4/1024/1024)}')
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL /usr/share/swift
docker image prune --all --force >/dev/null
after=$(df -Pk / | awk 'NR==2 {print int($4/1024/1024)}')
echo "Disco libre: ${before} GiB → ${after} GiB"
