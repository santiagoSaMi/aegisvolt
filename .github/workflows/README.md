# Workflows de GitHub Actions

Diseño: [ADR-0035](../../docs/adr/0035-cicd-github-actions-runners-hospedados-floci-efimero.md) (reemplaza la parte self-hosted de ADR-0015). Configuración manual del repositorio (rulesets, environments, checks obligatorios): [github-repository-settings.md](../../docs/runbooks/github-repository-settings.md).

Solo **runners hospedados por GitHub**. Cada ejecución levanta su propio **Floci temporal** (versión fijada por digest) y nunca alcanza el Floci persistente del autor.

| Workflow | Disparador | Jobs |
| --- | --- | --- |
| `ci.yml` | PR → `dev`, `test`, `prod` | `promotion-guard`, `lint`, `typecheck`, `unit-tests`, `prefect-tests`, `graphql-schema`, `build`, `integration-tests`, `e2e-tests`, `docker-build`, `terraform-validate`, `ci-result` |
| `terraform-plan.yml` | PR → `dev`, `test`, `prod` | `terraform-plan` (plan del workspace destino sobre estado reconstruido; nunca apply) |
| `deploy-floci.yml` | push (merge) a `dev`, `test`, `prod`; manual en esas ramas | `resolve-environment`, `deploy`, `canary` |
| `canary-deployment.yml` | llamado por `deploy-floci`; manual | `canary-resolve`, `canary-analysis` |
| `security.yml` | PR, push, semanal, manual | `dependency-review`, `dependency-audit`, `secret-scan`, `codeql (…)`, `trivy-config`, `trivy-images` |

- **La lógica vive en `scripts/ci/`**, y se puede ejecutar y probar fuera de GitHub. Los workflows solo preparan el runner y la invocan.
- **Comprobación estática:** `python3 scripts/ci/check-workflows.py`, que corre en `lint`. Verifica Actions fijadas por SHA, permisos, nombres únicos, sin inyección y scripts existentes.
- **Nombres de job:** son los checks obligatorios. Si se renombra uno, hay que actualizar los rulesets.
