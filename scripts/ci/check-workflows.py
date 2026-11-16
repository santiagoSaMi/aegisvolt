#!/usr/bin/env python3
"""Comprobaciones estáticas de los workflows de GitHub Actions (ADR-0035).

Uso: python3 scripts/ci/check-workflows.py

Falla si:
  - un archivo no es YAML válido o le falta `on`/`jobs`;
  - una Action externa no está fijada por SHA completo (40 hex) con su versión en comentario;
  - dos jobs comparten `name` (GitHub lo desaconseja: los required checks se vuelven ambiguos);
  - un `needs` apunta a un job inexistente;
  - el workflow no declara `permissions` de nivel superior o un job no declara los suyos;
  - un `run:` interpola datos controlados por el autor de un PR (inyección de scripts);
  - un script del repositorio llamado en `run:` no existe o no es ejecutable.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
ACTIONS = sorted((ROOT / ".github" / "actions").glob("*/action.yml"))
PINNED = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
# Datos del evento que el autor de un PR controla (no deben ir dentro de `run:`).
UNTRUSTED = re.compile(
    r"\$\{\{\s*github\.(head_ref|event\.pull_request\.(title|body|head\.ref|head\.label)"
    r"|event\.(issue|comment|review)\b)"
)
SCRIPT = re.compile(r"(?<![\w/.-])(scripts/[\w./-]+\.(?:sh|py))")

errors: list[str] = []


def err(where: str, msg: str) -> None:
    errors.append(f"{where}: {msg}")


def check_uses(where: str, uses: str, raw: str) -> None:
    if uses.startswith("./"):
        if not (ROOT / uses / "action.yml").exists() and not (ROOT / uses).exists():
            err(where, f"acción local inexistente: {uses}")
        return
    if not PINNED.match(uses):
        err(where, f"Action no fijada por SHA completo: {uses}")
    elif not re.search(re.escape(uses) + r"\s+#\s*v\d", raw):
        err(where, f"falta el comentario con la versión junto a {uses}")


def check_run(where: str, run: str) -> None:
    if UNTRUSTED.search(run):
        err(where, "run: interpola datos del PR; páselos por `env:`")
    for script in SCRIPT.findall(run):
        path = ROOT / script
        if not path.exists():
            err(where, f"script inexistente: {script}")
        elif not os.access(path, os.X_OK) and not script.endswith(".py"):
            err(where, f"script sin permiso de ejecución: {script}")


def load(path: Path) -> tuple[dict, str]:
    raw = path.read_text()
    try:
        data = yaml.load(raw, Loader=yaml.BaseLoader)  # BaseLoader: `on` sigue siendo "on"
    except yaml.YAMLError as exc:
        err(path.name, f"YAML inválido: {exc}")
        return {}, raw
    return data or {}, raw


names: dict[str, str] = {}
for wf in WORKFLOWS:
    data, raw = load(wf)
    if not data:
        continue
    for key in ("on", "jobs", "name"):
        if key not in data:
            err(wf.name, f"falta `{key}`")
    if "permissions" not in data:
        err(wf.name, "falta `permissions` de nivel superior (use {} y conceda por job)")
    jobs = data.get("jobs", {})
    for job_id, job in jobs.items():
        where = f"{wf.name}#{job_id}"
        name = job.get("name", job_id)
        if "${{" not in name:
            if name in names:
                err(where, f"nombre de job repetido «{name}» (también en {names[name]})")
            names[name] = where
        if "permissions" not in job:
            err(where, "falta `permissions` del job")
        needs = job.get("needs", [])
        for need in [needs] if isinstance(needs, str) else needs:
            if need not in jobs:
                err(where, f"needs a un job inexistente: {need}")
        if "uses" in job:
            check_uses(where, job["uses"], raw)
        for i, step in enumerate(job.get("steps", [])):
            if "uses" in step:
                check_uses(f"{where} paso {i + 1}", step["uses"], raw)
            if "run" in step:
                check_run(f"{where} paso {i + 1}", step["run"])

for action in ACTIONS:
    data, raw = load(action)
    for i, step in enumerate(data.get("runs", {}).get("steps", [])):
        if "uses" in step:
            check_uses(f"{action.parent.name} paso {i + 1}", step["uses"], raw)
        if "run" in step:
            check_run(f"{action.parent.name} paso {i + 1}", step["run"])

if errors:
    print("\n".join(f"✗ {e}" for e in errors))
    sys.exit(1)
print(f"✓ {len(WORKFLOWS)} workflows y {len(ACTIONS)} acciones locales: {len(names)} jobs con nombre único")
for name, where in sorted(names.items()):
    print(f"  {name:<22} {where}")
