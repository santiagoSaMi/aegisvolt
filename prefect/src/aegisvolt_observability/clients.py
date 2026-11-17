"""Clientes HTTP de SOLO LECTURA hacia las APIs públicas de cada servicio (ADR-0030).

Prefect no lee tablas ajenas: cada dato viene del servicio dueño, por su contrato
(packages/contracts). Errores:
- 404 → `Lookup.NOT_FOUND`; 409 de tombstone (`*_VOIDED`, `RESERVATION_CANCELLED`) → `Lookup.VOIDED`;
- red, timeout o 5xx → `ServiceUnavailableError` (la task lo reintenta);
- otro 4xx → `ContractError` (no se reintenta: la consulta es inválida).
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any, Self

import httpx

from .model import (
    CompensationFailure,
    Debit,
    Fetched,
    HasStatus,
    LedgerEntry,
    Lookup,
    Reservation,
    Saga,
    ServiceHealth,
    Session,
)

USER_AGENT = "aegisvolt-audit/1.0 (prefect)"

#: Solo para pruebas: transporte HTTP simulado por URL base (httpx.MockTransport).
TRANSPORT_FACTORY: Callable[[str], httpx.BaseTransport] | None = None


def transport_for(base_url: str) -> httpx.BaseTransport | None:
    return None if TRANSPORT_FACTORY is None else TRANSPORT_FACTORY(base_url)


TOMBSTONE_CODES = frozenset({"DEBIT_VOIDED", "RESERVATION_CANCELLED", "SESSION_VOIDED"})


class ServiceUnavailableError(RuntimeError):
    """El servicio no respondió (red, timeout o 5xx): reintentable."""


class ContractError(RuntimeError):
    """El servicio rechazó la consulta (4xx inesperado) o respondió fuera del contrato."""


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _opt_ts(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


class ApiClient:
    """Cliente base: un `correlation_id` por ejecución de auditoría (trazable en CloudWatch)."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float,
        correlation_id: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.correlation_id = correlation_id or str(uuid.uuid4())
        self._http = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={"user-agent": USER_AGENT, "x-correlation-id": self.correlation_id, "accept": "application/json"},
            transport=transport or transport_for(base_url),
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _get(self, path: str, params: dict[str, Any] | None = None) -> httpx.Response:
        try:
            response = self._http.get(path, params={k: v for k, v in (params or {}).items() if v is not None})
        except httpx.HTTPError as error:  # red o timeout
            raise ServiceUnavailableError(f"GET {path}: {type(error).__name__}") from error
        if response.status_code >= 500:
            raise ServiceUnavailableError(f"GET {path}: HTTP {response.status_code}")
        return response

    def _json(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        response = self._get(path, params)
        if response.status_code != 200:
            raise ContractError(f"GET {path}: HTTP {response.status_code} {_problem_code(response)}")
        body = response.json()
        if not isinstance(body, dict):
            raise ContractError(f"GET {path}: respuesta no es un objeto JSON")
        return body

    def _fetch(self, path: str) -> tuple[Lookup, dict[str, Any] | None]:
        response = self._get(path)
        if response.status_code == 200:
            return Lookup.FOUND, response.json()
        if response.status_code == 404:
            return Lookup.NOT_FOUND, None
        if response.status_code == 409 and _problem_code(response) in TOMBSTONE_CODES:
            return Lookup.VOIDED, None
        raise ContractError(f"GET {path}: HTTP {response.status_code} {_problem_code(response)}")

    def _pages(self, path: str, params: dict[str, Any], max_pages: int) -> Iterator[dict[str, Any]]:
        cursor: str | None = None
        for _ in range(max_pages):
            body = self._json(path, {**params, "cursor": cursor})
            yield from body.get("items", [])
            cursor = body.get("nextCursor")
            if not cursor:
                return


def _problem_code(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    return str(body.get("code", "")) if isinstance(body, dict) else ""


# --- Mapeo de las vistas del contrato -------------------------------------------------


def saga_from_view(v: dict[str, Any]) -> Saga:
    failure = v.get("compensationFailure")
    return Saga(
        saga_id=v["sagaId"],
        status=v["status"],
        fleet_id=v["fleetId"],
        correlation_id=v["correlationId"],
        reservation_id=v["reservationId"],
        debit_id=v["debitId"],
        session_id=v["sessionId"],
        compensation_plan=tuple(v.get("compensationPlan", [])),
        compensation_failure=None
        if failure is None
        else CompensationFailure(
            step=failure["step"],
            error_code=failure["errorCode"],
            next_attempt_at=_opt_ts(failure.get("nextAttemptAt")),
        ),
        created_at=_ts(v["createdAt"]),
        updated_at=_ts(v["updatedAt"]),
    )


def reservation_from_view(v: dict[str, Any]) -> Reservation:
    return Reservation(
        reservation_id=v["reservationId"],
        saga_id=v["sagaId"],
        fleet_id=v["fleetId"],
        status=v["status"],
        hold_expires_at=_ts(v["holdExpiresAt"]),
        created_at=_ts(v["createdAt"]),
        updated_at=_ts(v["updatedAt"]),
    )


def debit_from_view(v: dict[str, Any]) -> Debit:
    return Debit(
        debit_id=v["debitId"],
        saga_id=v["sagaId"],
        fleet_id=v["fleetId"],
        status=v["status"],
        amount_minor=int(v["amount"]["amountMinor"]),
        currency=v["amount"]["currency"],
        created_at=_ts(v["createdAt"]),
        updated_at=_ts(v["updatedAt"]),
    )


def session_from_view(v: dict[str, Any]) -> Session:
    return Session(
        session_id=v["sessionId"],
        saga_id=v["sagaId"],
        status=v["status"],
        started_at=_ts(v["startedAt"]),
        ended_at=_opt_ts(v.get("endedAt")),
        updated_at=_ts(v["updatedAt"]),
    )


def ledger_from_view(v: dict[str, Any]) -> LedgerEntry:
    return LedgerEntry(
        transaction_id=v["transactionId"],
        fleet_id=v["fleetId"],
        type=v["type"],
        amount_minor=int(v["amount"]["amountMinor"]),
        saga_id=v.get("sagaId"),
        debit_id=v.get("debitId"),
        refund_id=v.get("refundId"),
        occurred_at=_ts(v["occurredAt"]),
    )


def _fetched[T: HasStatus](lookup: Lookup, body: dict[str, Any] | None, mapper: Any) -> Fetched[T]:
    return Fetched(lookup, None if body is None else mapper(body))


# --- Clientes por servicio --------------------------------------------------------------


class SagaOrchestratorClient(ApiClient):
    def sagas_by_status(
        self,
        status: str,
        *,
        updated_after: datetime | None = None,
        updated_before: datetime | None = None,
        limit: int = 50,
        max_pages: int = 20,
    ) -> list[Saga]:
        """`GET /v1/audit/sagas` (contrato 1.2.0): todas las flotas, la más antigua primero."""
        params = {
            "status": status,
            "limit": limit,
            "updatedAfter": _iso(updated_after),
            "updatedBefore": _iso(updated_before),
        }
        return [saga_from_view(v) for v in self._pages("/v1/audit/sagas", params, max_pages)]

    def saga(self, saga_id: str) -> Fetched[Saga]:
        lookup, body = self._fetch(f"/v1/sagas/{saga_id}")
        return _fetched(lookup, body, saga_from_view)


class StationReservationClient(ApiClient):
    def fleet_reservations(
        self, fleet_id: str, *, since: datetime, limit: int = 50, max_pages: int = 20
    ) -> list[Reservation]:
        """`GET /v1/reservations?fleetId=` (más reciente primero): se corta al salir de la ventana."""
        found: list[Reservation] = []
        for view in self._pages("/v1/reservations", {"fleetId": fleet_id, "limit": limit}, max_pages):
            reservation = reservation_from_view(view)
            if reservation.created_at < since:
                break
            found.append(reservation)
        return found


class BillingWalletClient(ApiClient):
    def ledger(self, fleet_id: str, *, since: datetime, limit: int = 50, max_pages: int = 20) -> list[LedgerEntry]:
        """`GET /v1/wallets/{fleetId}/transactions` (más reciente primero). 404 → flota sin billetera."""
        found: list[LedgerEntry] = []
        try:
            for view in self._pages(f"/v1/wallets/{fleet_id}/transactions", {"limit": limit}, max_pages):
                entry = ledger_from_view(view)
                if entry.occurred_at < since:
                    break
                found.append(entry)
        except ContractError as error:
            if "HTTP 404" in str(error):
                return []
            raise
        return found

    def debit(self, debit_id: str) -> Fetched[Debit]:
        lookup, body = self._fetch(f"/v1/debits/{debit_id}")
        return _fetched(lookup, body, debit_from_view)


class EnergyDispatchClient(ApiClient):
    def session(self, session_id: str) -> Fetched[Session]:
        lookup, body = self._fetch(f"/v1/sessions/{session_id}")
        if lookup is Lookup.FOUND and body is not None and body.get("status") == "VOIDED":
            return Fetched(Lookup.VOIDED, None)
        return _fetched(lookup, body, session_from_view)


def probe_health(
    base_url: str, service: str, *, timeout: float, transport: httpx.BaseTransport | None = None
) -> ServiceHealth:
    """`/health/live` y `/health/ready` (probes de Kubernetes de cada unidad)."""
    with httpx.Client(
        base_url=base_url,
        timeout=timeout,
        transport=transport or transport_for(base_url),
        headers={"user-agent": USER_AGENT},
    ) as http:
        try:
            started = time.perf_counter()
            live = http.get("/health/live").status_code == 200
            ready_response = http.get("/health/ready")
            latency = round((time.perf_counter() - started) * 1000, 1)
        except httpx.HTTPError as error:
            return ServiceHealth(service, False, False, None, f"sin respuesta ({type(error).__name__})")
    ready = ready_response.status_code == 200
    detail = "listo" if ready else f"/health/ready → HTTP {ready_response.status_code}"
    return ServiceHealth(service, live, ready, latency, detail)


def _iso(value: datetime | None) -> str | None:
    """Formato del contrato: ISO 8601 en UTC con milisegundos y `Z` (como `updatedAt`)."""
    if value is None:
        return None
    if value.tzinfo is None:
        raise ValueError("Las fechas de la auditoría deben tener zona horaria (UTC)")
    utc = value.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"
