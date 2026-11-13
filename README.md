# AegisVolt

Plataforma cloud-native para la gestión de carga de flotas de vehículos eléctricos. La especificación está en [`proyecto_final.md`](proyecto_final.md) y las reglas de trabajo en [`CLAUDE.md`](CLAUDE.md).

## Estado

| Fase | Estado |
| --- | --- |
| Entorno local AWS con Floci | Listo. Ver [`infra/local/floci/README.md`](infra/local/floci/README.md) |
| Diseño de arquitectura | Documentado en [`docs/architecture/`](docs/architecture/README.md), ADR 0002–0017; decisiones pendientes en [09](docs/architecture/09-analisis-especificacion.md) |

## Inicio rápido (entorno local)

```bash
scripts/floci/start.sh                 # inicia Floci 2.4.0 en http://localhost:4566 (persistente)
scripts/floci/smoke-test.sh            # verifica S3, DynamoDB, Logs, API Gateway, VPC/VPCE, ECR
scripts/floci/smoke-test.sh --with-eks # + EKS (k3s)
scripts/floci/terraform-check.sh       # verifica Terraform (provider + backend S3) contra Floci
scripts/floci/stop.sh                  # detiene sin borrar datos
```

Todo el desarrollo apunta a Floci con credenciales ficticias. **Nunca** se aprovisiona en una cuenta AWS real.

## Documentación

- [Arquitectura](docs/architecture/README.md)
- [ADR](docs/adr/)
- [Limitaciones conocidas del entorno local](docs/limitations.md)
