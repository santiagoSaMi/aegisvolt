"""Resultados de una auditoría y su publicación como artifacts de Prefect."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

from prefect.artifacts import create_markdown_artifact, create_table_artifact

from .model import Finding, Rule


@dataclass
class AuditReport:
    audit: str  # nombre del flow
    environment: str
    correlation_id: str  # x-correlation-id de todas las consultas (trazable en CloudWatch)
    started_at: datetime
    rules: tuple[Rule, ...]
    scanned: dict[str, int] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)  # consultas que no se pudieron evaluar

    @property
    def by_rule(self) -> Counter[str]:
        return Counter(f.rule.rule_id for f in self.findings)

    def metrics(self) -> list[tuple[str, dict[str, str], float]]:
        base = {"Environment": self.environment, "Audit": self.audit}
        out: list[tuple[str, dict[str, str], float]] = [("Findings", base, float(len(self.findings)))]
        out += [
            ("FindingsByRule", {**base, "Rule": r.rule_id}, float(self.by_rule.get(r.rule_id, 0))) for r in self.rules
        ]
        out += [("AuditErrors", base, float(len(self.errors)))]
        return out


def artifact_key(audit: str, environment: str) -> str:
    """Clave estable (minúsculas y guiones): cada ejecución crea una versión nueva."""
    return f"{audit.replace('_', '-')}-{environment}".lower()


def markdown(report: AuditReport) -> str:
    lines = [
        f"# {report.audit} · {report.environment}",
        "",
        f"- Inicio: {report.started_at.isoformat()}",
        f"- correlation_id de las consultas: `{report.correlation_id}`",
        f"- Revisado: {', '.join(f'{k}={v}' for k, v in report.scanned.items()) or '—'}",
        f"- Hallazgos: **{len(report.findings)}**",
        "",
    ]
    if report.errors:
        lines += ["## Consultas que no se pudieron evaluar", ""] + [f"- {e}" for e in report.errors] + [""]
    lines += [
        "## Reglas evaluadas",
        "",
        "| Regla | Severidad | Hallazgos | Condición | Por qué es inconsistente |",
        "| --- | --- | --- | --- | --- |",
    ]
    for rule in report.rules:
        lines.append(
            f"| {rule.rule_id} · {rule.title} | {rule.severity.value} | {report.by_rule.get(rule.rule_id, 0)} "
            f"| {rule.statement} | {rule.rationale} |"
        )
    if report.findings:
        lines += ["", "## Hallazgos", ""]
        for finding in report.findings:
            lines.append(f"- {finding.explanation()} **Acción:** {finding.rule.action}")
    return "\n".join(lines)


def publish(report: AuditReport) -> None:
    key = artifact_key(report.audit, report.environment)
    create_markdown_artifact(
        key=key, markdown=markdown(report), description=f"{report.audit} en {report.environment}: reglas y hallazgos"
    )
    create_table_artifact(
        key=f"{key}-findings",
        table=[f.as_row() for f in report.findings] or [{"resultado": "sin hallazgos"}],
        description=f"Hallazgos de {report.audit} en {report.environment}",
    )
