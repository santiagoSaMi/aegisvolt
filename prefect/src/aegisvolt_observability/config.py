"""Configuración de la auditoría (TOML validado). Solo URLs de APIs y umbrales:
Prefect no recibe credenciales de las tablas de los servicios (ADR-0030)."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

from .model import AuditThresholds

Environment = Literal["dev", "test", "prod"]
SERVICES = (
    "saga_orchestrator",
    "station_reservation",
    "billing_wallet",
    "energy_dispatch",
    "graphql_api",
)
#: service_name de cada unidad (logs, log groups y etiquetas de Kubernetes).
SERVICE_NAMES = {
    "saga_orchestrator": "saga-orchestrator-service",
    "station_reservation": "station-reservation-service",
    "billing_wallet": "billing-wallet-service",
    "energy_dispatch": "energy-dispatch-service",
    "graphql_api": "graphql-api",
}
DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "config" / "local.toml"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class EnvironmentEndpoints(_Strict):
    """URL base de cada unidad de un ambiente (en Kubernetes, el Service interno)."""

    saga_orchestrator: HttpUrl
    station_reservation: HttpUrl
    billing_wallet: HttpUrl
    energy_dispatch: HttpUrl
    graphql_api: HttpUrl

    def url(self, service: str) -> str:
        return str(getattr(self, service)).rstrip("/")


class AuditSettings(_Strict):
    lookback_hours: int = Field(24, ge=1, le=24 * 30)
    #: Flotas a revisar además de las descubiertas en las SAGAs de la ventana.
    fleets: tuple[str, ...] = ()
    page_limit: int = Field(50, ge=1, le=100)
    max_pages: int = Field(20, ge=1, le=1000)

    @field_validator("fleets")
    @classmethod
    def _fleet_format(cls, fleets: tuple[str, ...]) -> tuple[str, ...]:
        for fleet in fleets:
            if not fleet.startswith("fleet_"):
                raise ValueError(f"flota inválida: {fleet}")
        return fleets


class Thresholds(_Strict):
    stale_after_seconds: int = Field(600, ge=60)
    settle_seconds: int = Field(120, ge=0)
    compensation_retry_grace_seconds: int = Field(300, ge=0)
    session_end_grace_seconds: int = Field(300, ge=0)

    def to_model(self) -> AuditThresholds:
        return AuditThresholds(**self.model_dump())


class HttpSettings(_Strict):
    timeout_seconds: float = Field(3.0, gt=0, le=30)


class CloudWatchSettings(_Strict):
    """Publicación de métricas de auditoría (AegisVolt/Audit) y lectura de log groups.
    En local SOLO Floci (CLAUDE.md: nunca AWS real)."""

    enabled: bool = True
    endpoint_url: str = "http://localhost:4566"
    region: str = "us-east-1"
    namespace: str = "AegisVolt/Audit"

    @field_validator("endpoint_url")
    @classmethod
    def _local_only(cls, url: str) -> str:
        if not url.startswith(("http://localhost", "http://127.0.0.1", "https://localhost")):
            raise ValueError("cloudwatch.endpoint_url debe ser Floci local (http://localhost:4566)")
        return url


class Settings(_Strict):
    audit: AuditSettings = AuditSettings()
    thresholds: Thresholds = Thresholds()
    http: HttpSettings = HttpSettings()
    cloudwatch: CloudWatchSettings = CloudWatchSettings()
    environments: dict[Environment, EnvironmentEndpoints]


def load_settings(path: str | Path | None = None) -> Settings:
    """Lee `AEGISVOLT_AUDIT_CONFIG` (o `config/local.toml`)."""
    source = Path(path or os.environ.get("AEGISVOLT_AUDIT_CONFIG") or DEFAULT_CONFIG)
    with source.open("rb") as handle:
        return Settings.model_validate(tomllib.load(handle))
