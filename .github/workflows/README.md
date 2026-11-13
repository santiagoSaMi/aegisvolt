# Workflows de GitHub Actions

Pipelines de CI/CD ([ADR-0015](../../docs/adr/0015-cicd-github-actions-hibrido-y-promocion.md), [07-cicd.md](../../docs/architecture/07-cicd.md)).

**Checks pre-merge:**
- `promotion-guard`
- `lint-build`
- `unit-tests`
- `integration-tests`
- `e2e-tests`
- `terraform-plan`

**Post-merge:** se detecta el ambiente, se aplica la infraestructura y se despliega con canary.

Se implementan en la fase de CI/CD. GitHub solo ejecuta los archivos `.yml`/`.yaml` de este directorio.
