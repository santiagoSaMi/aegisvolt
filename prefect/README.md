# Prefect (Python)

Flujos de observabilidad de AegisVolt ([ADR-0014](../docs/adr/0014-observabilidad-cloudwatch-fluent-bit-prefect.md), [06-observabilidad.md](../docs/architecture/06-observabilidad.md)). Es el único componente en Python del proyecto (CLAUDE.md, regla 2).

| Flow | Propósito |
| --- | --- |
| `environment_health` | Salud de `dev`, `test` y `prod` |
| `saga_consistency_audit` | Detecta SAGAs huérfanas, compensadas o inconsistentes en DynamoDB (solo lectura) |
| `trace_correlation` | Reconstruye en CloudWatch la línea temporal de un `correlation_id` |

Se implementa en la fase de observabilidad (proyecto Python con `pyproject.toml`, Prefect 3.x). Queda fuera del workspace de pnpm.
