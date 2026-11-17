"""Observabilidad y auditoría de AegisVolt con Prefect (ADR-0030).

Solo lectura: consulta las APIs de cada servicio, detecta y reporta. Nunca
reanuda, compensa ni repara una SAGA (eso es del orquestador y de los runbooks).
"""
