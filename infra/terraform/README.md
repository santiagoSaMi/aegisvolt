# Terraform

Infraestructura como código ([ADR-0011](../../docs/adr/0011-terraform-workspaces-backend-s3-bootstrap.md), [05-infraestructura-y-despliegue.md](../../docs/architecture/05-infraestructura-y-despliegue.md)). Siempre contra **Floci**; nunca contra AWS real (CLAUDE.md).

| Directorio | Contenido | Estado |
| --- | --- | --- |
| `bootstrap/` | Bucket del estado remoto `aegisvolt-tfstate` (versionado, cifrado, sin acceso público). Estado local. | Implementado |
| `live/` | Raíz única con workspaces `dev`, `test` y `prod` (el workspace es el ambiente; otro nombre hace fallar el plan) | Solo observabilidad por ahora |
| `modules/observability/` | Log groups `/aegisvolt/<env>/<servicio>`, metric filters, alarmas y dashboard ([ADR-0029](../../docs/adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md)) | Implementado |
| `global/`, demás módulos | ECR, red, VPCE, DynamoDB, EKS, edge, identidad e IAM | Fase de IaC |

```bash
scripts/floci/terraform-live.sh dev            # bootstrap si falta el bucket, init, workspace, validate, plan
scripts/floci/terraform-live.sh dev apply      # aplica el plan guardado (igual con test y prod)
```

- **Estado:** `s3://aegisvolt-tfstate/env:/<workspace>/aegisvolt/terraform.tfstate`, con versionado y bloqueo nativo (`use_lockfile`).
- **Provider:** AWS `~> 6.73` (verificado 6.73.0), Terraform `>= 1.10` (verificado 1.17.2). Los endpoints apuntan a Floci y solo se aceptan endpoints locales; un servicio sin endpoint declarado iría a AWS real.
- **Verificado el 2026-11-14:** apply en los tres workspaces (29 recursos cada uno), un segundo plan sin cambios y el workspace `default` rechazado.
