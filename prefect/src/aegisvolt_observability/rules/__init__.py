"""Reglas de detección (funciones puras, sin E/S). Cada regla tiene un id estable,
un enunciado exacto y su justificación de negocio (ADR-0030). Ningún hallazgo se
emite sin citar la regla que lo produjo."""

from datetime import datetime, timedelta


def older_than(instant: datetime, now: datetime, seconds: int) -> bool:
    """`instant` ocurrió hace más de `seconds` segundos."""
    return now - instant > timedelta(seconds=seconds)
