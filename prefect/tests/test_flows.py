"""Flows de punta a punta con Prefect (servidor temporal) y servicios simulados que
sirven las fixtures. Verifica que las auditorías SOLO hacen GET a las APIs."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from prefect.testing.utilities import prefect_test_harness

from aegisvolt_observability.flows import (
    billing_consistency_audit,
    environment_health_monitor,
    reservation_consistency_audit,
    saga_consistency_audit,
)

from .conftest import FixtureWorld, uid


@pytest.fixture(autouse=True, scope="module")
def prefect_server() -> Iterator[None]:
    with prefect_test_harness():
        yield


def _rules(report: object) -> set[tuple[str, str]]:
    return {(f.rule.rule_id, f.subject_id) for f in report.findings}  # type: ignore[attr-defined]


def test_saga_audit(services: FixtureWorld) -> None:
    report = saga_consistency_audit(environment="dev")
    assert _rules(report) == {
        ("SAGA-001", f"saga_{uid(2)}"),
        ("SAGA-001", f"saga_{uid(12)}"),
        ("SAGA-002", f"saga_{uid(4)}"),
        ("SAGA-003", f"saga_{uid(5)}"),
        ("SAGA-004", f"saga_{uid(7)}"),
        ("SAGA-004", f"saga_{uid(20)}"),
        ("SAGA-005", f"saga_{uid(8)}"),
    }
    assert report.errors == []
    # Respeta los límites: solo lecturas, solo por las APIs públicas.
    assert {r.method for r in services.requests} == {"GET"}
    assert {r.url.host for r in services.requests} <= {"orchestrator.test", "dispatch.test"}
    assert len({r.headers["x-correlation-id"] for r in services.requests}) == 1


def test_reservation_audit(services: FixtureWorld) -> None:
    report = reservation_consistency_audit(environment="dev")
    assert _rules(report) == {
        ("RES-001", f"res_{uid(30)}"),
        ("RES-002", f"res_{uid(8)}"),
        ("RES-003", f"res_{uid(11)}"),
        ("RES-004", f"res_{uid(13)}"),
        ("RES-005", f"res_{uid(12)}"),
    }
    assert report.scanned["flotas"] == 1
    assert {r.method for r in services.requests} == {"GET"}


def test_billing_audit(services: FixtureWorld) -> None:
    report = billing_consistency_audit(environment="dev", fleets=["fleet_alfa"])
    assert _rules(report) == {
        ("BIL-001", f"dbt_{uid(40)}"),
        ("BIL-002", f"dbt_{uid(16)}"),
        ("BIL-003", f"dbt_{uid(20)}"),
        ("BIL-004", f"dbt_{uid(4)}"),
        ("BIL-005", f"dbt_{uid(15)}"),
        ("BIL-006", f"dbt_{uid(10)}"),
    }
    assert {r.method for r in services.requests} == {"GET"}


def test_unreachable_service_is_reported_not_flagged(services: FixtureWorld) -> None:
    """Si energy-dispatch no responde, las SAGAs que necesitan su sesión quedan como 'no
    evaluadas': una caída NO es evidencia de inconsistencia."""
    original = services.handler

    def flaky(request):  # type: ignore[no-untyped-def]
        if request.url.host == "dispatch.test":
            import httpx

            return httpx.Response(503)
        return original(request)

    services.handler = flaky  # type: ignore[method-assign]
    report = saga_consistency_audit(environment="dev")
    rule_ids = {f.rule.rule_id for f in report.findings}
    assert "SAGA-004" not in rule_ids and "SAGA-005" not in rule_ids
    assert {"SAGA-001", "SAGA-002", "SAGA-003"} <= rule_ids
    assert report.errors


def test_health_monitor(services: FixtureWorld) -> None:
    state = environment_health_monitor(environments=["dev"], check_logs=False, return_state=True)
    assert state.is_completed()
    (env,) = state.result()
    assert env.status.value == "OPERATIONAL" and len(env.services) == 5


def test_health_monitor_fails_when_strict_and_down(services: FixtureWorld) -> None:
    import httpx

    services.handler = lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused", request=request))  # type: ignore[method-assign]
    state = environment_health_monitor(environments=["dev"], check_logs=False, return_state=True)
    assert state.is_failed()
    assert "dev=DOWN" in (state.message or "")
