"""Fixtures compartidas: respuestas de las APIs (tests/fixtures/*.json) y servicios
simulados con httpx.MockTransport. Ninguna prueba abre conexiones reales."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from aegisvolt_observability.clients import (
    debit_from_view,
    ledger_from_view,
    reservation_from_view,
    saga_from_view,
    session_from_view,
)
from aegisvolt_observability.model import AuditThresholds, Fetched, Lookup

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = json.loads((FIXTURES / f"{name}.json").read_text())["items"]
    return data


NOW = datetime.fromisoformat(json.loads((FIXTURES / "sagas.json").read_text())["now"])
UUID = "00000000-0000-4000-8000-{:012d}"


def uid(n: int) -> str:
    return UUID.format(n)


@pytest.fixture
def thresholds() -> AuditThresholds:
    return AuditThresholds()


class FixtureWorld:
    """Estado de los cuatro servicios según las fixtures (lo que devolverían sus APIs)."""

    def __init__(self) -> None:
        self.sagas = {v["sagaId"]: v for v in load("sagas")}
        self.sessions = {v["sessionId"]: v for v in load("sessions")}
        self.reservations = {v["reservationId"]: v for v in load("reservations")}
        self.debits = {v["debitId"]: v for v in load("debits")}
        self.ledger = load("ledger")
        self.requests: list[httpx.Request] = []

    # Vistas tipadas (como las mapean los clientes)
    def saga(self, n: int) -> Fetched[Any]:
        view = self.sagas.get(f"saga_{uid(n)}")
        return Fetched(Lookup.NOT_FOUND) if view is None else Fetched.found(saga_from_view(view))

    def session(self, session_id: str) -> Fetched[Any]:
        view = self.sessions.get(session_id)
        return Fetched(Lookup.NOT_FOUND) if view is None else Fetched.found(session_from_view(view))

    def reservation(self, n: int) -> Any:
        return reservation_from_view(self.reservations[f"res_{uid(n)}"])

    def debit(self, n: int) -> Any:
        return debit_from_view(self.debits[f"dbt_{uid(n)}"])

    def ledger_entries(self) -> list[Any]:
        return [ledger_from_view(v) for v in self.ledger]

    # --- APIs simuladas (solo GET) -------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method != "GET":
            return httpx.Response(405)
        url = urlparse(str(request.url))
        host, path, query = url.hostname, url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
        if path in ("/health/live", "/health/ready"):
            return httpx.Response(200, json={"status": "ok"})
        if host == "orchestrator.test":
            if path == "/v1/audit/sagas":
                items = [
                    v
                    for v in self.sagas.values()
                    if v["status"] == query["status"]
                    and ("updatedAfter" not in query or v["updatedAt"] >= query["updatedAfter"])
                    and ("updatedBefore" not in query or v["updatedAt"] < query["updatedBefore"])
                ]
                return httpx.Response(200, json={"items": sorted(items, key=lambda v: v["updatedAt"])})
            return self._by_id(self.sagas, path.removeprefix("/v1/sagas/"), "SAGA_NOT_FOUND")
        if host == "dispatch.test":
            return self._by_id(self.sessions, path.removeprefix("/v1/sessions/"), "SESSION_NOT_FOUND")
        if host == "stations.test" and path == "/v1/reservations":
            items = [v for v in self.reservations.values() if v["fleetId"] == query["fleetId"]]
            return httpx.Response(200, json={"items": sorted(items, key=lambda v: v["createdAt"], reverse=True)})
        if host == "billing.test":
            if path.startswith("/v1/wallets/") and path.endswith("/transactions"):
                fleet = path.split("/")[3]
                return httpx.Response(200, json={"items": [e for e in self.ledger if e["fleetId"] == fleet]})
            return self._by_id(self.debits, path.removeprefix("/v1/debits/"), "DEBIT_NOT_FOUND")
        return httpx.Response(404, json={"code": "NOT_FOUND"})

    @staticmethod
    def _by_id(store: dict[str, Any], key: str, code: str) -> httpx.Response:
        if key in store:
            return httpx.Response(200, json=store[key])
        return httpx.Response(404, json={"code": code})


@pytest.fixture
def world() -> FixtureWorld:
    return FixtureWorld()


@pytest.fixture
def services(world: FixtureWorld, monkeypatch: pytest.MonkeyPatch) -> Iterator[FixtureWorld]:
    """Conecta los clientes a los servicios simulados y fija el reloj de la auditoría."""
    from aegisvolt_observability import clients
    from aegisvolt_observability.flows import common

    transport = httpx.MockTransport(lambda request: world.handler(request))  # resuelto en cada petición
    monkeypatch.setattr(clients, "TRANSPORT_FACTORY", lambda _base: transport)
    monkeypatch.setattr(common, "utcnow", lambda: NOW)
    monkeypatch.setenv("AEGISVOLT_AUDIT_CONFIG", str(FIXTURES / "config.toml"))
    yield world
