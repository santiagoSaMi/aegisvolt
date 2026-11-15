"""Despliegues programados en un proceso local (`flow.to_deployment` + `serve`).

Uso: `python -m aegisvolt_observability.serve` con PREFECT_API_URL apuntando al
Prefect Server local (ver README). Intervalos en segundos."""

from typing import Any, cast

from prefect import serve
from prefect.deployments.runner import RunnerDeployment

from .flows import (
    billing_consistency_audit,
    environment_health_monitor,
    reservation_consistency_audit,
    saga_consistency_audit,
)


def _sync(deployment: Any) -> RunnerDeployment:
    """`to_deployment` es síncrono fuera de un event loop (aquí siempre)."""
    return cast(RunnerDeployment, deployment)


def main(environment: str = "dev") -> None:
    params = {"environment": environment}
    serve(
        _sync(
            environment_health_monitor.to_deployment(
                name="health-every-5m", interval=300, parameters={"strict": True}, tags=["observability"]
            )
        ),
        _sync(
            saga_consistency_audit.to_deployment(
                name=f"saga-audit-{environment}", interval=600, parameters=params, tags=["audit", environment]
            )
        ),
        _sync(
            reservation_consistency_audit.to_deployment(
                name=f"reservation-audit-{environment}", interval=900, parameters=params, tags=["audit", environment]
            )
        ),
        _sync(
            billing_consistency_audit.to_deployment(
                name=f"billing-audit-{environment}", interval=900, parameters=params, tags=["audit", environment]
            )
        ),
    )


if __name__ == "__main__":
    main()
