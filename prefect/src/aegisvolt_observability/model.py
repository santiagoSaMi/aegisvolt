"""Vistas de solo lectura de los recursos de cada servicio (lo que devuelven sus APIs)
y los resultados de la auditoría. Sin lógica de acceso: las reglas son funciones puras."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol

# --- Vocabulario de los contratos (packages/contracts) ---------------------------------

SAGA_TERMINAL = frozenset({"COMPLETED", "COMPENSATED", "FAILED"})
SAGA_UNSUCCESSFUL = frozenset({"COMPENSATED", "FAILED"})
SAGA_IN_PROGRESS = frozenset(
    {"STARTED", "RESERVATION_COMPLETED", "BILLING_COMPLETED", "DISPATCH_COMPLETED", "COMPENSATING"}
)
SAGA_STATUSES = SAGA_TERMINAL | SAGA_IN_PROGRESS | {"COMPENSATION_FAILED"}
RESERVATION_ACTIVE = frozenset({"HELD", "CONFIRMED"})
SESSION_RUNNING_OR_DONE = frozenset({"ACTIVE", "COMPLETED"})


class Lookup(StrEnum):
    """Resultado de consultar un recurso por id."""

    FOUND = "FOUND"
    NOT_FOUND = "NOT_FOUND"  # 404: nunca se creó
    VOIDED = "VOIDED"  # tombstone: una compensación lo anuló antes de crearse


@dataclass(frozen=True)
class CompensationFailure:
    step: str
    error_code: str
    next_attempt_at: datetime | None


@dataclass(frozen=True)
class Saga:
    saga_id: str
    status: str
    fleet_id: str
    correlation_id: str
    reservation_id: str
    debit_id: str
    session_id: str
    compensation_plan: tuple[str, ...]
    compensation_failure: CompensationFailure | None
    created_at: datetime
    updated_at: datetime

    @property
    def terminal(self) -> bool:
        return self.status in SAGA_TERMINAL


@dataclass(frozen=True)
class Reservation:
    reservation_id: str
    saga_id: str
    fleet_id: str
    status: str
    hold_expires_at: datetime
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class Debit:
    debit_id: str
    saga_id: str
    fleet_id: str
    status: str
    amount_minor: int
    currency: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class Session:
    session_id: str
    saga_id: str
    status: str
    started_at: datetime
    ended_at: datetime | None
    updated_at: datetime


@dataclass(frozen=True)
class LedgerEntry:
    transaction_id: str
    fleet_id: str
    type: str  # DEBIT | REFUND | TOP_UP
    amount_minor: int
    saga_id: str | None
    debit_id: str | None
    refund_id: str | None
    occurred_at: datetime


class HasStatus(Protocol):
    @property
    def status(self) -> str: ...


@dataclass(frozen=True)
class Fetched[T: HasStatus]:
    """Un recurso consultado por id: encontrado, inexistente o anulado (tombstone)."""

    lookup: Lookup
    value: T | None = None

    @staticmethod
    def found(value: T) -> Fetched[T]:
        return Fetched(Lookup.FOUND, value)

    @property
    def status(self) -> str:
        """Estado observable: el del recurso, o NOT_FOUND / VOIDED."""
        if self.value is None:
            return self.lookup.value
        return str(self.value.status)


# --- Resultados -------------------------------------------------------------------------


class Severity(StrEnum):
    CRITICAL = "CRITICAL"  # dinero o conector afectados sin proceso que lo corrija
    HIGH = "HIGH"  # requiere intervención (runbook)
    MEDIUM = "MEDIUM"  # degradación que se corrige sola o con poco impacto


@dataclass(frozen=True)
class Rule:
    """Regla de detección: el hallazgo SIEMPRE cita su id y enunciado."""

    rule_id: str
    title: str
    statement: str  # condición exacta que se evalúa
    rationale: str  # por qué es una inconsistencia según el negocio
    severity: Severity
    action: str  # qué hacer (runbook); Prefect no repara


@dataclass(frozen=True)
class Finding:
    rule: Rule
    subject_type: str  # SAGA | RESERVATION | DEBIT
    subject_id: str
    saga_id: str | None
    fleet_id: str | None
    correlation_id: str | None
    observed: dict[str, Any] = field(default_factory=dict)

    def explanation(self) -> str:
        facts = ", ".join(f"{k}={v}" for k, v in self.observed.items())
        return f"[{self.rule.rule_id}] {self.rule.statement} Observado: {facts}."

    def as_row(self) -> dict[str, Any]:
        return {
            "regla": self.rule.rule_id,
            "severidad": self.rule.severity.value,
            "sujeto": f"{self.subject_type} {self.subject_id}",
            "saga_id": self.saga_id or "—",
            "fleet_id": self.fleet_id or "—",
            "correlation_id": self.correlation_id or "—",
            "observado": ", ".join(f"{k}={v}" for k, v in self.observed.items()),
            "acción": self.rule.action,
        }


@dataclass(frozen=True)
class ServiceHealth:
    service: str
    live: bool
    ready: bool
    latency_ms: float | None
    detail: str


@dataclass(frozen=True)
class AuditThresholds:
    """Umbrales de tiempo (justificados en ADR-0030 a partir de la configuración del orquestador)."""

    #: Una SAGA no terminal sin cambios durante más tiempo está detenida: la recuperación
    #: (cada 10 s, retoma tras 15 s; plazo de avance 60 s) no la está procesando.
    stale_after_seconds: int = 600
    #: Entidades actualizadas más recientemente no se juzgan: pueden estar en curso y
    #: las lecturas a distintos servicios no son atómicas.
    settle_seconds: int = 120
    #: Tolerancia tras `nextAttemptAt` de una compensación fallida antes de alertar.
    compensation_retry_grace_seconds: int = 300
    #: Tras terminar la carga, el BFF libera la reserva; tolerancia para esa liberación.
    session_end_grace_seconds: int = 300
