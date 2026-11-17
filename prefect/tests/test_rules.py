"""Reglas de detección contra las fixtures: cada escenario dispara exactamente la regla
esperada (o ninguna). `_scenario` en tests/fixtures/*.json documenta cada caso."""

from __future__ import annotations

from aegisvolt_observability.model import AuditThresholds, Finding, Lookup, ServiceHealth
from aegisvolt_observability.rules import billing, reservations, saga
from aegisvolt_observability.rules.health import EnvironmentStatus, classify

from .conftest import NOW, FixtureWorld, uid


def _ids(findings: list[Finding]) -> set[tuple[str, str]]:
    return {(f.rule.rule_id, f.subject_id) for f in findings}


def test_saga_rules(world: FixtureWorld, thresholds: AuditThresholds) -> None:
    found: list[Finding] = []
    for n in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20):
        s = world.saga(n).value
        assert s is not None
        session = world.session(s.session_id) if saga.needs_session(s) else None
        found += saga.evaluate_saga(s, session, NOW, thresholds)

    assert _ids(found) == {
        ("SAGA-001", f"saga_{uid(2)}"),  # BILLING_COMPLETED sin cambios hace 30 min
        ("SAGA-001", f"saga_{uid(12)}"),  # STARTED sin cambios hace 40 min
        ("SAGA-002", f"saga_{uid(4)}"),  # COMPENSATION_FAILED sin nextAttemptAt
        ("SAGA-003", f"saga_{uid(5)}"),  # nextAttemptAt vencido hace 20 min
        ("SAGA-004", f"saga_{uid(7)}"),  # COMPLETED sin sesión (404)
        ("SAGA-004", f"saga_{uid(20)}"),  # COMPLETED con la sesión FAILED
        ("SAGA-005", f"saga_{uid(8)}"),  # COMPENSATED con la sesión ACTIVE
    }


def test_saga_rules_respect_thresholds(world: FixtureWorld) -> None:
    stuck = world.saga(2).value  # BILLING_COMPLETED hace 30 min
    assert stuck is not None
    assert saga.evaluate_saga(stuck, None, NOW, AuditThresholds(stale_after_seconds=3600)) == []
    assert [f.rule.rule_id for f in saga.evaluate_saga(stuck, None, NOW, AuditThresholds())] == ["SAGA-001"]


def test_reservation_rules(world: FixtureWorld, thresholds: AuditThresholds) -> None:
    found: list[Finding] = []
    for reservation_view in world.reservations.values():
        r = reservations_from(world, reservation_view["reservationId"])
        s = world.saga(int(r.saga_id[-12:]))
        session = world.session(s.value.session_id) if reservations.needs_session(r) and s.value else None
        found += reservations.evaluate_reservation(r, s, session, NOW, thresholds)

    assert _ids(found) == {
        ("RES-001", f"res_{uid(30)}"),  # HELD y su SAGA no existe
        ("RES-002", f"res_{uid(8)}"),  # CONFIRMED con SAGA COMPENSATED
        ("RES-003", f"res_{uid(11)}"),  # HELD con SAGA COMPLETED
        ("RES-004", f"res_{uid(13)}"),  # CONFIRMED; la carga terminó hace 1 h
        ("RES-005", f"res_{uid(12)}"),  # HELD de una SAGA detenida
    }


def reservations_from(world: FixtureWorld, reservation_id: str):  # type: ignore[no-untyped-def]
    from aegisvolt_observability.clients import reservation_from_view

    return reservation_from_view(world.reservations[reservation_id])


def test_billing_rules(world: FixtureWorld, thresholds: AuditThresholds) -> None:
    found: list[Finding] = []
    debits = {}
    for debit_view in world.debits.values():
        d = world.debit(int(debit_view["debitId"][-12:]))
        debits[d.debit_id] = d
        s = world.saga(int(d.saga_id[-12:]))
        session = world.session(s.value.session_id) if billing.needs_session(d, s) and s.value else None
        found += billing.evaluate_debit(d, s, session, NOW, thresholds)
    found += billing.duplicated_refunds(world.ledger_entries(), debits)

    assert _ids(found) == {
        ("BIL-001", f"dbt_{uid(40)}"),  # DEBITED sin SAGA
        ("BIL-002", f"dbt_{uid(16)}"),  # DEBITED con SAGA COMPENSATED
        ("BIL-003", f"dbt_{uid(20)}"),  # DEBITED, SAGA COMPLETED, sesión FAILED
        ("BIL-004", f"dbt_{uid(4)}"),  # reembolso pendiente (COMPENSATION_FAILED hace 1 h)
        ("BIL-005", f"dbt_{uid(15)}"),  # REFUNDED con SAGA COMPLETED
        ("BIL-006", f"dbt_{uid(10)}"),  # dos REFUND en el libro mayor
    }


def test_voided_resources_count_as_not_running(world: FixtureWorld, thresholds: AuditThresholds) -> None:
    """Un tombstone (VOIDED) no es una sesión activa: SAGA-004 se dispara igual que con 404."""
    from aegisvolt_observability.model import Fetched

    completed = world.saga(1).value
    assert completed is not None
    findings = saga.evaluate_saga(completed, Fetched(Lookup.VOIDED), NOW, thresholds)
    assert [f.rule.rule_id for f in findings] == ["SAGA-004"]
    assert findings[0].observed["sesion"] == "VOIDED"


def test_every_finding_explains_its_rule(world: FixtureWorld, thresholds: AuditThresholds) -> None:
    """Ningún hallazgo sin regla: id, enunciado, justificación, acción y hechos observados."""
    s = world.saga(4).value
    assert s is not None
    (finding,) = saga.evaluate_saga(s, None, NOW, thresholds)
    text = finding.explanation()
    assert text.startswith("[SAGA-002] ")
    assert "COMPENSATION_FAILED" in text and "Observado:" in text
    for rule in saga.RULES + reservations.RULES + billing.RULES:
        assert rule.statement and rule.rationale and rule.action
    row = finding.as_row()
    assert row["regla"] == "SAGA-002" and row["correlation_id"] == "corr-4"


def test_rule_ids_are_unique() -> None:
    ids = [r.rule_id for r in saga.RULES + reservations.RULES + billing.RULES]
    assert len(ids) == len(set(ids))


def test_environment_classification() -> None:
    ok = ServiceHealth("a", True, True, 5.0, "listo")
    not_ready = ServiceHealth("b", True, False, 5.0, "HTTP 503")
    down = ServiceHealth("c", False, False, None, "sin respuesta")
    assert classify([ok, ok], True) is EnvironmentStatus.OPERATIONAL
    assert classify([ok, ok], None) is EnvironmentStatus.OPERATIONAL  # log groups no comprobados
    assert classify([ok, ok], False) is EnvironmentStatus.DEGRADED  # faltan log groups
    assert classify([ok, not_ready], True) is EnvironmentStatus.DEGRADED
    assert classify([down, down], True) is EnvironmentStatus.DOWN
    assert classify([], True) is EnvironmentStatus.DOWN
