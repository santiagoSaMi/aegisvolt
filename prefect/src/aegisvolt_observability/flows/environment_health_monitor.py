"""environment_health_monitor: disponibilidad de las unidades de cada ambiente."""

from __future__ import annotations

from dataclasses import dataclass

from prefect import flow
from prefect.artifacts import create_markdown_artifact, create_table_artifact
from prefect.client.schemas.objects import State
from prefect.logging import get_run_logger
from prefect.states import Completed, Failed

from ..config import SERVICE_NAMES, SERVICES, load_settings
from ..model import ServiceHealth
from ..rules.health import EnvironmentStatus, classify
from ..tasks import check_log_groups, check_service_health, publish_metrics


@dataclass(frozen=True)
class EnvironmentHealth:
    environment: str
    status: EnvironmentStatus
    services: list[ServiceHealth]
    missing_log_groups: list[str] | None


@flow(name="environment_health_monitor", log_prints=False)
def environment_health_monitor(
    environments: list[str] | None = None, check_logs: bool = True, strict: bool = True
) -> State:
    """Sondea /health/live y /health/ready de las cinco unidades de cada ambiente y la
    existencia de sus log groups. Regla HEALTH-001: OPERATIONAL solo si todas están listas.
    Con `strict`, el flow termina en Failed si algún ambiente no está OPERATIONAL."""
    logger = get_run_logger()
    settings = load_settings()
    envs = environments or list(settings.environments)
    results: list[EnvironmentHealth] = []
    for env in envs:
        endpoints = settings.environments[env]  # type: ignore[index]
        futures = [
            check_service_health.submit(env, SERVICE_NAMES[s], endpoints.url(s), settings.http.timeout_seconds)
            for s in SERVICES
        ]
        services = [f.result() for f in futures]
        missing = (
            check_log_groups(env, list(SERVICE_NAMES.values()), settings.cloudwatch)
            if check_logs and settings.cloudwatch.enabled
            else None
        )
        status = classify(services, None if missing is None else not missing)
        logger.info("Ambiente %s: %s", env, status.value)
        results.append(EnvironmentHealth(env, status, services, missing))

    rows = [
        {
            "ambiente": r.environment,
            "estado": r.status.value,
            "servicio": s.service,
            "live": s.live,
            "ready": s.ready,
            "latencia_ms": s.latency_ms,
            "detalle": s.detail,
        }
        for r in results
        for s in r.services
    ]
    create_table_artifact(key="environment-health", table=rows, description="Salud por ambiente y servicio")
    summary = [
        "# Salud de los ambientes",
        "",
        "Regla HEALTH-001: un ambiente está OPERATIONAL solo si sus cinco unidades responden "
        "`/health/ready` y existen sus log groups `/aegisvolt/<env>/<servicio>`; DOWN si ninguna "
        "responde `/health/live`; DEGRADED en otro caso.",
        "",
    ]
    summary += [
        f"- **{r.environment}**: {r.status.value}"
        + (f" (faltan log groups: {', '.join(r.missing_log_groups)})" if r.missing_log_groups else "")
        for r in results
    ]
    create_markdown_artifact(
        key="environment-health-summary", markdown="\n".join(summary), description="Resumen de salud"
    )
    publish_metrics(
        settings.cloudwatch,
        [
            (
                "EnvironmentHealthy",
                {"Environment": r.environment},
                1.0 if r.status is EnvironmentStatus.OPERATIONAL else 0.0,
            )
            for r in results
        ]
        + [
            ("ServiceReady", {"Environment": r.environment, "ServiceName": s.service}, 1.0 if s.ready else 0.0)
            for r in results
            for s in r.services
        ],
    )

    unhealthy = [r for r in results if r.status is not EnvironmentStatus.OPERATIONAL]
    message = ", ".join(f"{r.environment}={r.status.value}" for r in results)
    if strict and unhealthy:
        return Failed(message=f"Ambientes no operativos: {message}", data=results)
    return Completed(message=message, data=results)
