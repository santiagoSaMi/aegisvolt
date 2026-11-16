#!/usr/bin/env bash
# Valida el par rama origen → rama destino de un pull request (ADR-0035).
#
# Uso: scripts/ci/promotion-guard.sh <rama origen> <rama destino> <repo origen> <repo destino>
#
# Permitido:
#   feature/* | fix/* | chore/* | docs/*  →  dev
#   dependabot/*                         →  dev    (solo desde este repositorio: el prefijo de
#                                                   las ramas de Dependabot no es configurable)
#   dev                                  →  test   (solo desde este mismo repositorio)
#   test                                 →  prod   (solo desde este mismo repositorio)
# Todo lo demás se rechaza (exit 1). Ninguna regla nativa de GitHub restringe la rama
# ORIGEN de un PR: este check obligatorio lo hace. Un fork puede tener una rama llamada
# `dev`; por eso las promociones exigen que el origen sea el mismo repositorio.
set -euo pipefail

HEAD_REF="${1:-}"; BASE_REF="${2:-}"; HEAD_REPO="${3:-}"; BASE_REPO="${4:-}"
if [[ -z "$HEAD_REF" || -z "$BASE_REF" || -z "$HEAD_REPO" || -z "$BASE_REPO" ]]; then
  echo "Uso: $0 <rama origen> <rama destino> <repo origen> <repo destino>" >&2
  exit 2
fi

reject() { echo "::error title=Promoción no permitida::$1"; echo "RECHAZADO: $1"; exit 1; }
same_repo() { [[ "$HEAD_REPO" == "$BASE_REPO" ]]; }

case "$BASE_REF" in
  dev)
    if [[ "$HEAD_REF" =~ ^dependabot/[A-Za-z0-9._/-]+$ ]]; then
      same_repo || reject "dependabot/* → dev debe originarse en ${BASE_REPO}."
    else
      [[ "$HEAD_REF" =~ ^(feature|fix|chore|docs)/[A-Za-z0-9._/-]+$ ]] \
        || reject "${HEAD_REF} → dev: solo se admiten ramas feature/*, fix/*, chore/* o docs/* (y dependabot/*)."
    fi
    ;;
  test)
    [[ "$HEAD_REF" == dev ]] || reject "${HEAD_REF} → test: test solo recibe PRs desde dev."
    same_repo || reject "dev → test debe originarse en ${BASE_REPO}, no en ${HEAD_REPO}."
    ;;
  prod)
    [[ "$HEAD_REF" == test ]] || reject "${HEAD_REF} → prod: prod solo recibe PRs desde test."
    same_repo || reject "test → prod debe originarse en ${BASE_REPO}, no en ${HEAD_REPO}."
    ;;
  *)
    reject "La rama destino ${BASE_REF} no es dev, test ni prod."
    ;;
esac
echo "OK: ${HEAD_REF} (${HEAD_REPO}) → ${BASE_REF}"
