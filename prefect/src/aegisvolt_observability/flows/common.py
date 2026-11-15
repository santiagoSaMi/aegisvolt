"""Piezas compartidas por los flows de auditoría."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from prefect.futures import PrefectFuture

from ..config import Settings, load_settings
from ..model import SAGA_STATUSES, AuditThresholds, Saga
from ..tasks import list_sagas_by_status


def utcnow() -> datetime:
    """Reloj de la auditoría (reemplazable en pruebas)."""
    return datetime.now(UTC)


@dataclass(frozen=True)
class AuditContext:
    environment: str
    settings: Settings
    thresholds: AuditThresholds
    now: datetime
    since: datetime
    correlation_id: str

    def url(self, service: str) -> str:
        return self.settings.environments[self.environment].url(service)  # type: ignore[index]

    @property
    def timeout(self) -> float:
        return self.settings.http.timeout_seconds


def context(environment: str, lookback_hours: int | None = None) -> AuditContext:
    settings = load_settings()
    if environment not in settings.environments:
        raise ValueError(f"Ambiente sin configurar: {environment}")
    now = utcnow()
    hours = lookback_hours or settings.audit.lookback_hours
    return AuditContext(
        environment=environment,
        settings=settings,
        thresholds=settings.thresholds.to_model(),
        now=now,
        since=now - timedelta(hours=hours),
        # Todas las consultas de esta ejecución comparten un correlation_id: los
        # servicios lo registran, así que la auditoría también es trazable en CloudWatch.
        correlation_id=str(uuid.uuid4()),
    )


def discover_fleets(ctx: AuditContext) -> list[str]:
    """Flotas con SAGAs actualizadas en la ventana (cualquier estado) + las configuradas.
    Así se recorren las reservas y débitos por flota con las APIs de cada servicio."""
    futures: list[PrefectFuture[list[Saga]]] = [
        list_sagas_by_status.submit(
            ctx.url("saga_orchestrator"),
            status,
            ctx.since,
            None,
            ctx.settings.audit.page_limit,
            ctx.settings.audit.max_pages,
            ctx.timeout,
            ctx.correlation_id,
        )
        for status in sorted(SAGA_STATUSES)
    ]
    fleets = {saga.fleet_id for future in futures for saga in future.result()}
    return sorted(fleets | set(ctx.settings.audit.fleets))
