"""Reglas de `reservation_consistency_audit`: la reserva como sujeto."""

from datetime import datetime

from ..model import (
    RESERVATION_ACTIVE,
    SAGA_IN_PROGRESS,
    SAGA_UNSUCCESSFUL,
    AuditThresholds,
    Fetched,
    Finding,
    Reservation,
    Rule,
    Saga,
    Session,
    Severity,
)
from . import older_than

RES_001 = Rule(
    "RES-001",
    "Reserva activa sin SAGA",
    "La reserva está HELD o CONFIRMED y el orquestador no tiene la SAGA que la creó (404).",
    "Toda reserva pertenece a una SAGA (sagaId obligatorio). Sin SAGA no hay proceso que la "
    "confirme ni que la libere: es huérfana y bloquea el conector.",
    Severity.CRITICAL,
    "Liberar la reserva (POST /v1/reservations/{id}/release) tras confirmar que no hay carga.",
)
RES_002 = Rule(
    "RES-002",
    "Reserva activa de una SAGA sin éxito",
    "La reserva está HELD o CONFIRMED y su SAGA terminó COMPENSATED o FAILED.",
    "La compensación RELEASE_RESERVATION debía liberarla; el conector queda bloqueado para otras flotas.",
    Severity.CRITICAL,
    "Revisar la compensación de la SAGA; liberar la reserva con el runbook.",
)
RES_003 = Rule(
    "RES-003",
    "SAGA completada con la reserva sin confirmar",
    "La reserva está HELD y su SAGA está COMPLETED.",
    "COMPLETED exige el paso CONFIRMATION (la reserva pasa a CONFIRMED y el conector a OCCUPIED); "
    "el hold vencerá y el conector quedará libre con una carga en curso.",
    Severity.HIGH,
    "Confirmar la reserva o revisar el paso CONFIRMATION en el historial de la SAGA.",
)
RES_004 = Rule(
    "RES-004",
    "Conector ocupado sin carga",
    "La reserva está CONFIRMED pero la sesión de su SAGA no está ACTIVE (terminó, falló, fue "
    "anulada o no existe) desde hace más de `session_end_grace`.",
    "Al terminar la carga el conector debe liberarse; una reserva CONFIRMED sin carga deja el "
    "conector OCCUPIED indefinidamente.",
    Severity.HIGH,
    "Liberar la reserva (stopChargingSession / release) y revisar por qué no se liberó.",
)
RES_005 = Rule(
    "RES-005",
    "Hold retenido por una SAGA detenida",
    "La reserva está HELD y su SAGA sigue en un estado no terminal sin cambios desde hace más de `stale_after`.",
    "El hold bloquea el conector mientras la SAGA no avanza; la SAGA detenida se reporta además en SAGA-001.",
    Severity.MEDIUM,
    "Ver SAGA-001 para la misma SAGA; el hold vence solo al cumplirse holdExpiresAt.",
)

RULES = (RES_001, RES_002, RES_003, RES_004, RES_005)


def _finding(rule: Rule, reservation: Reservation, owner: Saga | None, **observed: object) -> Finding:
    return Finding(
        rule=rule,
        subject_type="RESERVATION",
        subject_id=reservation.reservation_id,
        saga_id=reservation.saga_id,
        fleet_id=reservation.fleet_id,
        correlation_id=owner.correlation_id if owner else None,
        observed={"reserva": reservation.status, **observed},
    )


def evaluate_reservation(
    reservation: Reservation,
    saga: Fetched[Saga],
    session: Fetched[Session] | None,
    now: datetime,
    t: AuditThresholds,
) -> list[Finding]:
    # Solo reservas activas y estables (las recientes pueden estar en plena SAGA).
    if reservation.status not in RESERVATION_ACTIVE or not older_than(reservation.updated_at, now, t.settle_seconds):
        return []
    if saga.value is None:
        return [_finding(RES_001, reservation, None, saga=saga.status)]
    s = saga.value
    findings: list[Finding] = []
    if s.status in SAGA_UNSUCCESSFUL:
        findings.append(_finding(RES_002, reservation, s, saga=s.status))
    if reservation.status == "HELD" and s.status == "COMPLETED":
        findings.append(_finding(RES_003, reservation, s, saga=s.status))
    if (
        reservation.status == "HELD"
        and s.status in SAGA_IN_PROGRESS
        and older_than(s.updated_at, now, t.stale_after_seconds)
    ):
        findings.append(
            _finding(RES_005, reservation, s, saga=s.status, holdExpiresAt=reservation.hold_expires_at.isoformat())
        )
    if reservation.status == "CONFIRMED" and session is not None and session.status != "ACTIVE":
        ended = session.value.ended_at if session.value is not None else None
        reference = ended or (session.value.updated_at if session.value else reservation.updated_at)
        if older_than(reference, now, t.session_end_grace_seconds):
            findings.append(_finding(RES_004, reservation, s, sesion=session.status, session_id=s.session_id))
    return findings


def needs_session(reservation: Reservation) -> bool:
    return reservation.status == "CONFIRMED"
