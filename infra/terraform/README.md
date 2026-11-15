# Terraform

Infraestructura como código ([ADR-0011](../../docs/adr/0011-terraform-workspaces-backend-s3-bootstrap.md), [ADR-0033](../../docs/adr/0033-terraform-modular-backend-s3-floci.md), [05-infraestructura-y-despliegue.md](../../docs/architecture/05-infraestructura-y-despliegue.md)). Siempre contra **Floci**, nunca contra AWS real (CLAUDE.md). Procedimientos y evidencias: [runbook](../../docs/runbooks/terraform-floci.md).

Versiones: Terraform **1.17.1** y provider `hashicorp/aws` **6.71.0** (fijado en cada raíz y en `.terraform.lock.hcl`).

## Raíces

| Raíz | Estado en `s3://aegisvolt-tfstate` | Contenido |
| --- | --- | --- |
| `bootstrap/` | `bootstrap/terraform.tfstate` | Bucket del estado: versionado, SSE, *public access block*, `BucketOwnerEnforced`, política mínima y retención de versiones |
| `global/` | `global/terraform.tfstate` | Compartido por los ambientes: repositorios ECR y ajuste de cuenta de API Gateway |
| `live/` | `env:/<dev\|test\|prod>/aegisvolt/terraform.tfstate` | Un **workspace** por ambiente: red, DynamoDB, IAM, EKS, API Gateway y CloudWatch |

Cada raíz tiene:

- `config/floci/backend.hcl`: backend S3 en Floci, con `use_lockfile` y credenciales ficticias; no hereda nada del provider;
- `config/floci/target.tfvars`: destino `floci`, endpoint local validado y cuenta `000000000000`.

`live/envs/<env>.tfvars` contiene la configuración del ambiente. Una precondición exige que coincida con el workspace.

## Módulos

| Módulo | Recursos |
| --- | --- |
| `dynamodb-table` | Tabla PK/SK con GSIs, TTL, PITR y protección contra borrado |
| `network` | VPC, subredes públicas y privadas (2–3 AZ), IGW, NAT, rutas, VPCE Gateway (S3, DynamoDB) e Interface (CloudWatch, API Gateway, EKS, ECR, STS, ELB) |
| `iam` | Rol de mínimo privilegio por ServiceAccount (EKS Pod Identity) |
| `eks` | Clúster, node group, roles, addon y asociaciones de Pod Identity |
| `api-gateway` | NLB interno, VPC Link, API REST REGIONAL y PRIVATE (`aws:SourceVpce`), stage con logs y throttling |
| `cloudwatch` | Log groups `/aegisvolt/<env>/<servicio>`, metric filters, alarmas y dashboard ([ADR-0029](../../docs/adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md)) |
| `ecr` | Repositorios inmutables con escaneo y retención |

## Uso

```bash
scripts/floci/terraform-bootstrap.sh apply     # bucket del estado (crea o migra su estado al bucket)
scripts/floci/terraform-global.sh apply        # ECR y ajustes compartidos
scripts/floci/terraform-live.sh dev            # fmt, init, workspace dev, validate, plan
scripts/floci/terraform-live.sh dev apply      # aplica ese plan (igual con test y prod)
scripts/floci/terraform-adopt.sh <global|env>  # una vez: importa lo creado antes por scripts
scripts/floci/terraform-evidence.sh            # evidencias de workspaces, estados, versiones y lock
```

- Los scripts rechazan los planes que destruyen o reemplazan recursos. Ninguno ejecuta `destroy`.
- **Nunca se lee `~/.aws`:** el provider y el backend usan `/dev/null` como archivos compartidos, y los scripts quitan `AWS_PROFILE`.
- Una URL no local en la configuración o un `floci_endpoint` no local hacen fallar el script o el plan.
- `*.tfstate*`, `*.tfplan` y `.terraform/` no se versionan.
