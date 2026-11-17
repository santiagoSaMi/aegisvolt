"""Reglas de `billing_consistency_audit`: el débito como sujeto."""

from collections import Counter
from datetime import datetime

from ..model import (
    SAGA_UNSUCCESSFUL,
    SESSION_RUNNING_OR_DONE,
    AuditThresholds,
    Debit,
    Fetched,
    Finding,
    LedgerEntry,
    Rule,
    Saga,
    Session,
    Severity,
)
from . import older_than

BIL_001 = Rule(
    "BIL-001",
    "Débito sin SAGA",
    "El débito está DEBITED y el orquestador no tiene su SAGA (404).",
    "Todo cobro pertenece a una SAGA; sin ella ningún proceso lo reembolsará si la carga no ocurre.",
    Severity.CRITICAL,
    "Contrastar con el libro mayor de la flota y reembolsar con el runbook si no hubo carga.",
)
BIL_002 = Rule(
    "BIL-002",
    "Débito no reembolsado de una SAGA sin éxito",
    "El débito está DEBITED y su SAGA terminó COMPENSATED o FAILED.",
    "La compensación REFUND_DEBIT debía devolver el importe: la flota pagó por una carga que no se entregó.",
    Severity.CRITICAL,
    "Revisar la compensación REFUND_DEBIT; reintento controlado de la SAGA.",
)
BIL_003 = Rule(
    "BIL-003",
    "Débito sin sesión correspondiente",
    "El débito está DEBITED, su SAGA está COMPLETED y la sesión de carga no existe, fue anulada "
    "o está en FAILED/ABORTED.",
    "El cobro solo se justifica con una carga activada (sesión ACTIVE o COMPLETED).",
    Severity.CRITICAL,
    "Contrastar con energy-dispatch y reembolsar si no hubo carga (escalar a soporte).",
)
BIL_004 = Rule(
    "BIL-004",
    "Reembolso pendiente demasiado tiempo",
    "El débito está DEBITED, su SAGA está en COMPENSATING o COMPENSATION_FAILED con REFUND_DEBIT "
    "en el plan de compensación, y no cambia desde hace más de `stale_after`.",
    "Hay una compensación de dinero en curso que no termina: el saldo de la flota queda retenido.",
    Severity.HIGH,
    "Ver SAGA-001/002/003 de la misma SAGA y el reintento controlado.",
)
BIL_005 = Rule(
    "BIL-005",
    "Reembolso de una carga exitosa",
    "El débito está REFUNDED y su SAGA está COMPLETED.",
    "Una SAGA completada no compensa: el reembolso contradice el resultado y la carga quedó gratis.",
    Severity.HIGH,
    "Revisar el historial de la SAGA y del débito; escalar a facturación.",
)
BIL_006 = Rule(
    "BIL-006",
    "Más de un reembolso para un débito",
    "El libro mayor de la flota tiene más de un movimiento REFUND con el mismo debitId.",
    "El reembolso es idempotente por débito; dos devoluciones abonan el importe dos veces.",
    Severity.CRITICAL,
    "Escalar a facturación con los transactionId del libro mayor.",
)

RULES = (BIL_001, BIL_002, BIL_003, BIL_004, BIL_005, BIL_006)


def _finding(rule: Rule, debit: Debit, owner: Saga | None, **observed: object) -> Finding:
    return Finding(
        rule=rule,
        subject_type="DEBIT",
        subject_id=debit.debit_id,
        saga_id=debit.saga_id,
        fleet_id=debit.fleet_id,
        correlation_id=owner.correlation_id if owner else None,
        observed={"debito": debit.status, "importe": f"{debit.amount_minor} {debit.currency}", **observed},
    )


def needs_session(debit: Debit, saga: Fetched[Saga]) -> bool:
    return debit.status == "DEBITED" and saga.value is not None and saga.value.status == "COMPLETED"


def evaluate_debit(
    debit: Debit,
    saga: Fetched[Saga],
    session: Fetched[Session] | None,
    now: datetime,
    t: AuditThresholds,
) -> list[Finding]:
    if not older_than(debit.updated_at, now, t.settle_seconds):
        return []
    s = saga.value
    if s is None:
        return [_finding(BIL_001, debit, None, saga=saga.status)] if debit.status == "DEBITED" else []
    findings: list[Finding] = []
    if debit.status == "DEBITED":
        if s.status in SAGA_UNSUCCESSFUL:
            findings.append(_finding(BIL_002, debit, s, saga=s.status))
        if s.status == "COMPLETED" and session is not None and session.status not in SESSION_RUNNING_OR_DONE:
            findings.append(_finding(BIL_003, debit, s, saga=s.status, sesion=session.status, session_id=s.session_id))
        if (
            s.status in {"COMPENSATING", "COMPENSATION_FAILED"}
            and "REFUND_DEBIT" in s.compensation_plan
            and older_than(s.updated_at, now, t.stale_after_seconds)
        ):
            findings.append(_finding(BIL_004, debit, s, saga=s.status))
    if debit.status == "REFUNDED" and s.status == "COMPLETED":
        findings.append(_finding(BIL_005, debit, s, saga=s.status))
    return findings


def duplicated_refunds(entries: list[LedgerEntry], debits: dict[str, Debit]) -> list[Finding]:
    """BIL-006 sobre el libro mayor de una flota (sin consultas adicionales)."""
    counts = Counter(e.debit_id for e in entries if e.type == "REFUND" and e.debit_id)
    findings: list[Finding] = []
    for debit_id, count in counts.items():
        if count <= 1:
            continue
        refunds = [e.transaction_id for e in entries if e.type == "REFUND" and e.debit_id == debit_id]
        debit = debits.get(debit_id)
        fleet = next(e.fleet_id for e in entries if e.debit_id == debit_id)
        findings.append(
            Finding(
                rule=BIL_006,
                subject_type="DEBIT",
                subject_id=debit_id,
                saga_id=debit.saga_id if debit else None,
                fleet_id=fleet,
                correlation_id=None,
                observed={"reembolsos": count, "transacciones": " ".join(refunds)},
            )
        )
    return findings
