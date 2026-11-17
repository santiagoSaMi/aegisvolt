"""Reglas de `saga_consistency_audit`: la SAGA como sujeto."""

from datetime import datetime

from ..model import (
    SAGA_IN_PROGRESS,
    SAGA_UNSUCCESSFUL,
    SESSION_RUNNING_OR_DONE,
    AuditThresholds,
    Fetched,
    Finding,
    Rule,
    Saga,
    Session,
    Severity,
)
from . import older_than

SAGA_001 = Rule(
    "SAGA-001",
    "SAGA detenida",
    "La SAGA está en un estado no terminal (STARTED, RESERVATION_COMPLETED, BILLING_COMPLETED, "
    "DISPATCH_COMPLETED o COMPENSATING) y no cambia desde hace más del umbral `stale_after`.",
    "El orquestador retoma una SAGA sin avance tras 15 s y cada paso tiene un plazo de 60 s; "
    "superar el umbral significa que la recuperación no la está procesando y el conector o el "
    "saldo quedan retenidos.",
    Severity.HIGH,
    "Revisar los logs del orquestador por correlation_id y el RecoveryWorker (runbook saga-demo).",
)
SAGA_002 = Rule(
    "SAGA-002",
    "Compensación fallida sin reintento programado",
    "La SAGA está en COMPENSATION_FAILED y no tiene `compensationFailure.nextAttemptAt`.",
    "Se agotaron las rondas automáticas de compensación: ningún proceso volverá a intentar "
    "reembolsar o liberar, así que el estado no se corrige solo.",
    Severity.CRITICAL,
    "Reintento controlado: POST /v1/sagas/{sagaId}/compensation/retry (runbook saga-demo).",
)
SAGA_003 = Rule(
    "SAGA-003",
    "Reintento de compensación vencido",
    "La SAGA está en COMPENSATION_FAILED con `nextAttemptAt` vencido hace más de `compensation_retry_grace`.",
    "La recuperación debía reintentar la compensación en `nextAttemptAt`; si no lo hizo, el "
    "worker no está corriendo o no puede tomar el lease.",
    Severity.HIGH,
    "Verificar que el RecoveryWorker del orquestador esté activo (logs operation=RecoverSagas).",
)
SAGA_004 = Rule(
    "SAGA-004",
    "SAGA completada sin carga",
    "La SAGA está COMPLETED pero su sesión de carga no existe, fue anulada o está en FAILED/ABORTED.",
    "COMPLETED significa que el cargador se activó (paso pivote). Sin sesión ACTIVE o COMPLETED, "
    "la flota pagó una carga que energy-dispatch no registra.",
    Severity.CRITICAL,
    "Contrastar la SAGA con energy-dispatch (GET /v1/sessions/{sessionId}) y escalar.",
)
SAGA_005 = Rule(
    "SAGA-005",
    "Carga activa en una SAGA sin éxito",
    "La SAGA terminó COMPENSATED o FAILED pero su sesión de carga sigue ACTIVE.",
    "Una SAGA sin éxito debe haber abortado la sesión (ABORT_SESSION); una carga activa entrega "
    "energía que se reembolsó o nunca se cobró.",
    Severity.CRITICAL,
    "Detener la sesión (stopChargingSession) y revisar la compensación ABORT_SESSION.",
)

RULES = (SAGA_001, SAGA_002, SAGA_003, SAGA_004, SAGA_005)


def _finding(rule: Rule, saga: Saga, **observed: object) -> Finding:
    return Finding(
        rule=rule,
        subject_type="SAGA",
        subject_id=saga.saga_id,
        saga_id=saga.saga_id,
        fleet_id=saga.fleet_id,
        correlation_id=saga.correlation_id,
        observed={"status": saga.status, "updatedAt": saga.updated_at.isoformat(), **observed},
    )


def needs_session(saga: Saga) -> bool:
    """La sesión solo se consulta cuando una regla la necesita (menos llamadas)."""
    return saga.status == "COMPLETED" or saga.status in SAGA_UNSUCCESSFUL


def evaluate_saga(saga: Saga, session: Fetched[Session] | None, now: datetime, t: AuditThresholds) -> list[Finding]:
    findings: list[Finding] = []

    if saga.status in SAGA_IN_PROGRESS and older_than(saga.updated_at, now, t.stale_after_seconds):
        minutes = int((now - saga.updated_at).total_seconds() // 60)
        findings.append(_finding(SAGA_001, saga, sin_cambios_min=minutes))

    if saga.status == "COMPENSATION_FAILED":
        failure = saga.compensation_failure
        if failure is None or failure.next_attempt_at is None:
            findings.append(
                _finding(
                    SAGA_002, saga, paso=failure.step if failure else "?", error=failure.error_code if failure else "?"
                )
            )
        elif older_than(failure.next_attempt_at, now, t.compensation_retry_grace_seconds):
            findings.append(
                _finding(SAGA_003, saga, nextAttemptAt=failure.next_attempt_at.isoformat(), paso=failure.step)
            )

    # Reglas sobre SAGAs terminadas: solo si están estables (lecturas no atómicas).
    if session is None or not older_than(saga.updated_at, now, t.settle_seconds):
        return findings
    if saga.status == "COMPLETED" and session.status not in SESSION_RUNNING_OR_DONE:
        findings.append(_finding(SAGA_004, saga, sesion=session.status, session_id=saga.session_id))
    if saga.status in SAGA_UNSUCCESSFUL and session.status == "ACTIVE":
        findings.append(_finding(SAGA_005, saga, sesion="ACTIVE", session_id=saga.session_id))
    return findings
