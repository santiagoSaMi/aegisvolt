"""Clasificación de la salud de un ambiente a partir de sus servicios."""

from enum import StrEnum

from ..model import ServiceHealth


class EnvironmentStatus(StrEnum):
    OPERATIONAL = "OPERATIONAL"  # todos listos
    DEGRADED = "DEGRADED"  # alguno no listo (o faltan log groups)
    DOWN = "DOWN"  # ninguno responde


def classify(services: list[ServiceHealth], log_groups_ok: bool | None) -> EnvironmentStatus:
    """Regla HEALTH-001: OPERATIONAL solo si TODAS las unidades responden /health/ready
    y (si se comprueban) existen sus log groups /aegisvolt/<env>/<servicio>."""
    if not services or not any(s.live for s in services):
        return EnvironmentStatus.DOWN
    if all(s.ready for s in services) and log_groups_ok is not False:
        return EnvironmentStatus.OPERATIONAL
    return EnvironmentStatus.DEGRADED
