#!/usr/bin/env bash
# Resumen Markdown de un plan guardado: conteos y una fila por recurso con su acción.
# Solo direcciones y acciones: nunca valores de atributos (sin datos sensibles).
#
# Uso: scripts/ci/terraform-plan-summary.sh <raíz: bootstrap|global|live> <plan> <título>
set -euo pipefail
ROOT="$1"; PLAN="$2"; TITLE="$3"
DIR="$(cd "$(dirname "$0")/../../infra/terraform/${ROOT}" && pwd)"
json="$(terraform -chdir="$DIR" show -json "$PLAN")"
count() { jq --arg a "$1" '[.resource_changes[]? | select(.change.actions | index($a))] | length' <<<"$json"; }
add=$(count create); chg=$(count update); del=$(count delete)
echo "### ${TITLE}"
echo
echo "**${add}** a crear · **${chg}** a cambiar · **${del}** a destruir"
if (( del > 0 )); then
  echo
  echo "> ⚠️ El plan **destruye o reemplaza** recursos. Revíselos antes de aprobar."
fi
if (( add + chg + del > 0 )); then
  echo
  echo "<details><summary>Recursos afectados</summary>"
  echo
  echo "| Acción | Recurso |"
  echo "| --- | --- |"
  jq -r '.resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])
    | "| \(.change.actions | join(" → ")) | `\(.address)` |"' <<<"$json"
  echo
  echo "</details>"
fi
echo
