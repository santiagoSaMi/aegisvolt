"""Tasks reutilizables de los flows. Cada una hace UNA consulta de solo lectura a un
servicio, con reintentos ante fallos transitorios, timeout y logging. Sin caché:
una auditoría siempre lee el estado actual."""

from __future__ import annotations

from datetime import datetime

import boto3
from botocore.config import Config
from prefect import task
from prefect.cache_policies import NO_CACHE
from prefect.logging import get_run_logger

from .clients import (
    BillingWalletClient,
    EnergyDispatchClient,
    SagaOrchestratorClient,
    StationReservationClient,
    probe_health,
)
from .config import CloudWatchSettings
from .model import Debit, Fetched, LedgerEntry, Reservation, Saga, ServiceHealth, Session

# Reintentos con espera creciente (2 s y 10 s): cubren reinicios de pods y picos de
# latencia sin alargar demasiado una auditoría.
#
# Timeouts: los aplica cada cliente (httpx: `http.timeout_seconds` por petición, y
# páginas acotadas por `audit.max_pages`; boto3: conexión y lectura de 5 s). No se usa
# `timeout_seconds` de Prefect: en tasks síncronas no puede interrumpir una llamada
# bloqueante (lo advierte Prefect 3.9), así que daría una falsa sensación de control.
RETRIES = 2
RETRY_DELAYS: list[float] = [2, 10]
AWS_CONFIG = Config(connect_timeout=5, read_timeout=5, retries={"max_attempts": 3, "mode": "standard"})


@task(
    name="check-service-health",
    retries=1,
    retry_delay_seconds=2,
    cache_policy=NO_CACHE,
    task_run_name="health-{environment}-{service}",
)
def check_service_health(environment: str, service: str, base_url: str, timeout: float) -> ServiceHealth:
    health = probe_health(base_url, service, timeout=timeout)
    logger = get_run_logger()
    if health.ready:
        logger.info("%s/%s listo (%s ms)", environment, service, health.latency_ms)
    else:
        logger.warning("%s/%s NO listo: %s", environment, service, health.detail)
    return health


@task(name="check-log-groups", cache_policy=NO_CACHE, task_run_name="log-groups-{environment}")
def check_log_groups(environment: str, services: list[str], cloudwatch: CloudWatchSettings) -> list[str]:
    """Log groups /aegisvolt/<env>/<servicio> que faltan (los crea Terraform, ADR-0029).
    Lee metadatos de CloudWatch, no datos de negocio."""
    logs = boto3.client(
        "logs",
        endpoint_url=cloudwatch.endpoint_url,
        region_name=cloudwatch.region,
        aws_access_key_id="test",
        aws_secret_access_key="test",  # ficticias: solo Floci (validado en la configuración)
        config=AWS_CONFIG,
    )
    prefix = f"/aegisvolt/{environment}/"
    existing: set[str] = set()
    for page in logs.get_paginator("describe_log_groups").paginate(logGroupNamePrefix=prefix):
        existing.update(group["logGroupName"] for group in page.get("logGroups", []))
    missing = [s for s in services if f"{prefix}{s}" not in existing]
    if missing:
        get_run_logger().warning("Faltan log groups en %s: %s", environment, ", ".join(missing))
    return missing


@task(
    name="list-sagas-by-status",
    task_run_name="sagas-{status}",
    retries=RETRIES,
    retry_delay_seconds=RETRY_DELAYS,
    cache_policy=NO_CACHE,
)
def list_sagas_by_status(
    base_url: str,
    status: str,
    updated_after: datetime | None,
    updated_before: datetime | None,
    limit: int,
    max_pages: int,
    timeout: float,
    correlation_id: str,
) -> list[Saga]:
    with SagaOrchestratorClient(base_url, timeout=timeout, correlation_id=correlation_id) as client:
        sagas = client.sagas_by_status(
            status, updated_after=updated_after, updated_before=updated_before, limit=limit, max_pages=max_pages
        )
    get_run_logger().info("%d SAGAs en %s", len(sagas), status)
    return sagas


@task(
    name="fetch-saga",
    task_run_name="saga-{saga_id}",
    retries=RETRIES,
    retry_delay_seconds=RETRY_DELAYS,
    cache_policy=NO_CACHE,
)
def fetch_saga(base_url: str, saga_id: str, timeout: float, correlation_id: str) -> Fetched[Saga]:
    with SagaOrchestratorClient(base_url, timeout=timeout, correlation_id=correlation_id) as client:
        return client.saga(saga_id)


@task(
    name="fetch-session",
    task_run_name="session-{session_id}",
    retries=RETRIES,
    retry_delay_seconds=RETRY_DELAYS,
    cache_policy=NO_CACHE,
)
def fetch_session(base_url: str, session_id: str, timeout: float, correlation_id: str) -> Fetched[Session]:
    with EnergyDispatchClient(base_url, timeout=timeout, correlation_id=correlation_id) as client:
        return client.session(session_id)


@task(
    name="fetch-debit",
    task_run_name="debit-{debit_id}",
    retries=RETRIES,
    retry_delay_seconds=RETRY_DELAYS,
    cache_policy=NO_CACHE,
)
def fetch_debit(base_url: str, debit_id: str, timeout: float, correlation_id: str) -> Fetched[Debit]:
    with BillingWalletClient(base_url, timeout=timeout, correlation_id=correlation_id) as client:
        return client.debit(debit_id)


@task(
    name="list-fleet-reservations",
    task_run_name="reservations-{fleet_id}",
    retries=RETRIES,
    retry_delay_seconds=RETRY_DELAYS,
    cache_policy=NO_CACHE,
)
def list_fleet_reservations(
    base_url: str, fleet_id: str, since: datetime, limit: int, max_pages: int, timeout: float, correlation_id: str
) -> list[Reservation]:
    with StationReservationClient(base_url, timeout=timeout, correlation_id=correlation_id) as client:
        reservations = client.fleet_reservations(fleet_id, since=since, limit=limit, max_pages=max_pages)
    get_run_logger().info("%d reservas de %s en la ventana", len(reservations), fleet_id)
    return reservations


@task(
    name="list-fleet-ledger",
    task_run_name="ledger-{fleet_id}",
    retries=RETRIES,
    retry_delay_seconds=RETRY_DELAYS,
    cache_policy=NO_CACHE,
)
def list_fleet_ledger(
    base_url: str, fleet_id: str, since: datetime, limit: int, max_pages: int, timeout: float, correlation_id: str
) -> list[LedgerEntry]:
    with BillingWalletClient(base_url, timeout=timeout, correlation_id=correlation_id) as client:
        entries = client.ledger(fleet_id, since=since, limit=limit, max_pages=max_pages)
    get_run_logger().info("%d movimientos de %s en la ventana", len(entries), fleet_id)
    return entries


@task(name="publish-metrics", retries=1, retry_delay_seconds=2, cache_policy=NO_CACHE)
def publish_metrics(cloudwatch: CloudWatchSettings, metrics: list[tuple[str, dict[str, str], float]]) -> int:
    """Publica métricas en CloudWatch (namespace AegisVolt/Audit). Nunca escribe datos de negocio."""
    if not cloudwatch.enabled or not metrics:
        return 0
    client = boto3.client(
        "cloudwatch",
        endpoint_url=cloudwatch.endpoint_url,
        region_name=cloudwatch.region,
        aws_access_key_id="test",
        aws_secret_access_key="test",  # ficticias: solo Floci (validado en la configuración)
        config=AWS_CONFIG,
    )
    data = [
        {
            "MetricName": name,
            "Dimensions": [{"Name": k, "Value": v} for k, v in dims.items()],
            "Value": value,
            "Unit": "Count",
        }
        for name, dims, value in metrics
    ]
    for start in range(0, len(data), 20):  # máximo por llamada de PutMetricData
        client.put_metric_data(Namespace=cloudwatch.namespace, MetricData=data[start : start + 20])
    get_run_logger().info("%d métricas publicadas en %s", len(data), cloudwatch.namespace)
    return len(data)
