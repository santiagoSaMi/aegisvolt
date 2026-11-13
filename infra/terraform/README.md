# Terraform

Infraestructura como código ([ADR-0011](../../docs/adr/0011-terraform-workspaces-backend-s3-bootstrap.md), [05-infraestructura-y-despliegue.md](../../docs/architecture/05-infraestructura-y-despliegue.md)):

| Directorio | Contenido |
| --- | --- |
| `bootstrap/` | Bucket del estado remoto (con versionado) |
| `global/` | Recursos compartidos entre ambientes (ECR) |
| `live/` | Raíz única con workspaces `dev`, `test` y `prod` |
| `modules/` | Módulos reutilizables: red, VPCE, DynamoDB, EKS, edge, identidad, observabilidad e IAM |

Se implementa en la fase de IaC, siempre contra Floci. La verificación inicial de la integración está en [`infra/local/floci/terraform-check/`](../local/floci/terraform-check/).
