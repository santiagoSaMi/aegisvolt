"""Clientes HTTP de solo lectura: mapeo de respuestas y errores según los contratos."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from aegisvolt_observability.clients import (
    BillingWalletClient,
    ContractError,
    EnergyDispatchClient,
    SagaOrchestratorClient,
    ServiceUnavailableError,
    probe_health,
)
from aegisvolt_observability.model import Lookup

from .conftest import FixtureWorld, uid


def client[C](cls: type[C], handler: object) -> C:
    return cls(
        "http://svc.test",
        timeout=1,
        correlation_id="audit-1",  # type: ignore[call-arg]
        transport=httpx.MockTransport(handler),
    )  # type: ignore[arg-type]


def test_saga_found_not_found_and_headers(world: FixtureWorld) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        sid = request.url.path.removeprefix("/v1/sagas/")
        view = world.sagas.get(sid)
        return httpx.Response(200, json=view) if view else httpx.Response(404, json={"code": "SAGA_NOT_FOUND"})

    c = client(SagaOrchestratorClient, handler)
    found = c.saga(f"saga_{uid(4)}")
    assert found.lookup is Lookup.FOUND and found.value is not None
    assert found.value.compensation_failure is not None and found.value.compensation_failure.next_attempt_at is None
    assert c.saga(f"saga_{uid(999)}").lookup is Lookup.NOT_FOUND
    # Solo GET, con el correlation_id de la auditoría (trazable en los logs de los servicios).
    assert {r.method for r in seen} == {"GET"}
    assert seen[0].headers["x-correlation-id"] == "audit-1"


def test_tombstones_map_to_voided() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v1/debits/"):
            return httpx.Response(409, json={"code": "DEBIT_VOIDED"})
        return httpx.Response(200, json={"sessionId": "ses_x", "status": "VOIDED"})

    assert client(BillingWalletClient, handler).debit("dbt_x").lookup is Lookup.VOIDED
    assert client(EnergyDispatchClient, handler).session("ses_x").lookup is Lookup.VOIDED


@pytest.mark.parametrize(
    ("response", "error"),
    [
        (httpx.Response(503), ServiceUnavailableError),
        (httpx.Response(500), ServiceUnavailableError),
        (httpx.Response(400, json={"code": "VALIDATION_ERROR"}), ContractError),
        (httpx.Response(409, json={"code": "IDEMPOTENCY_CONFLICT"}), ContractError),
    ],
)
def test_errors_are_classified(response: httpx.Response, error: type[Exception]) -> None:
    with pytest.raises(error):
        client(SagaOrchestratorClient, lambda _r: response).saga("saga_x")


def test_network_errors_are_retryable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ServiceUnavailableError):
        client(SagaOrchestratorClient, handler).saga("saga_x")


def test_audit_listing_follows_cursor_and_sends_utc_range(world: FixtureWorld) -> None:
    views = list(world.sagas.values())
    queries: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        query = dict(request.url.params)
        queries.append(query)
        page = int(query.get("cursor", "0"))
        body: dict[str, object] = {"items": views[page * 2 : page * 2 + 2]}
        if page * 2 + 2 < len(views):
            body["nextCursor"] = str(page + 1)
        return httpx.Response(200, json=body)

    after = datetime(2026, 11, 14, 7, 0, 0, 123000, tzinfo=UTC)
    sagas = client(SagaOrchestratorClient, handler).sagas_by_status(
        "COMPLETED", updated_after=after, limit=2, max_pages=50
    )
    assert len(sagas) == len(views)
    assert queries[0] == {"status": "COMPLETED", "limit": "2", "updatedAfter": "2026-11-14T07:00:00.123Z"}
    assert queries[1]["cursor"] == "1"


def test_ledger_of_unknown_fleet_is_empty() -> None:
    handler = lambda _r: httpx.Response(404, json={"code": "WALLET_NOT_FOUND"})  # noqa: E731
    since = datetime(2026, 1, 1, tzinfo=UTC)
    assert client(BillingWalletClient, handler).ledger("fleet_nadie", since=since) == []


def test_naive_datetimes_are_rejected() -> None:
    with pytest.raises(ValueError, match="zona horaria"):
        client(SagaOrchestratorClient, lambda _r: httpx.Response(200, json={"items": []})).sagas_by_status(
            "COMPLETED", updated_after=datetime(2026, 1, 1)
        )


def test_health_probe() -> None:
    def ready(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200 if request.url.path == "/health/live" else 503)

    health = probe_health("http://svc.test", "svc", timeout=1, transport=httpx.MockTransport(ready))
    assert health.live and not health.ready and "503" in health.detail

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    health = probe_health("http://svc.test", "svc", timeout=1, transport=httpx.MockTransport(down))
    assert not health.live and health.latency_ms is None
