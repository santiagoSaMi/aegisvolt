# ADR-0011: Terraform con raíz única por workspace, backend S3 versionado, bootstrap y guardas por ambiente

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.4 exige:
- módulos de Terraform;
- `tfstate` remoto en S3 con *versioning*;
- un workspace por ambiente (`dev`, `test`, `prod`) con prefijos `env:/<ws>/`;
- nombres parametrizados con `${terraform.workspace}`.

La documentación de Terraform advierte que los workspaces "are not a suitable isolation mechanism" cuando se requieren credenciales separadas. El bucket de estado no puede gestionarse con su propio estado. `dynamodb_table` está deprecado en favor de `use_lockfile`.

## Decisión

- **`infra/terraform/bootstrap/`** crea el bucket de estado (versioning, SSE, *public access block*). Se aplica con estado local y luego migra su estado al bucket.
- **`infra/terraform/global/`** contiene los recursos compartidos entre ambientes (repositorios ECR, para promover el mismo digest), con su propia clave de estado.
- **`infra/terraform/live/`** es una **raíz única** con workspaces `dev`, `test` y `prod`:
  - backend S3 parcial: clave `aegisvolt/terraform.tfstate`, prefijo `env:` y `use_lockfile = true`;
  - `-var-file=envs/<ws>.tfvars`.
- **Guardas:**
  - precondición `terraform.workspace ∈ {dev,test,prod}` y `var.environment == terraform.workspace`;
  - nombres derivados del workspace;
  - `prevent_destroy` y `deletion_protection` en `prod`;
  - workspace derivado de la rama en CI;
  - `concurrency` por ambiente.
- **Runbook** de restauración desde una versión previa del `tfstate`.

## Alternativas

1. **Un directorio por ambiente** (`envs/dev`, `envs/test`, `envs/prod`) con estados distintos. Aísla mejor, pero incumple el uso obligatorio de workspaces.
2. **Terragrunt.** Una dependencia adicional no exigida (regla 10).
3. **Cuentas AWS separadas por ambiente.** Es lo recomendado en producción real. Floci usa una sola cuenta; se documenta como evolución.
4. **Bloqueo con tabla DynamoDB.** Deprecado.

## Consecuencias

- **Positivas:** cumple literalmente la especificación con mitigaciones comprobables. La restauración del estado se puede demostrar con las versiones de S3, ya verificadas en Floci.
- **Negativas:**
  - Los tres ambientes comparten backend y credenciales; el aislamiento depende de las guardas y de la disciplina del CI.
  - `bootstrap` requiere un procedimiento manual documentado de una sola vez.
