# ADR-0035: CI/CD con GitHub Actions en runners hospedados y Floci efímero

- **Estado:** Aceptado
- **Fecha:** 2026-11-15
- **Reemplaza en parte:** [ADR-0015](0015-cicd-github-actions-hibrido-y-promocion.md). Se mantienen la estrategia de ramas, `promotion-guard`, los métodos de merge y la concurrencia por ambiente. Se reemplazan los runners self-hosted y el despliegue en el Floci persistente.

## Contexto

ADR-0015 proponía un modelo híbrido: un runner self-hosted en el equipo del autor para el plan, el apply y el canary contra el Floci persistente. El autor aclaró en esta fase:

- el repositorio es **público** y usa **GitHub Free**;
- **no** se registra un self-hosted runner, y solo se usan runners hospedados;
- cada ejecución levanta su propio Floci, con una versión fijada;
- el Floci del autor no se expone a Internet;
- no se inventa persistencia entre ejecuciones;
- los environments `dev`, `test` y `prod` ya existen y se configuran a mano.

Datos verificados en la documentación de GitHub:

- **Runner estándar de repositorio público:** 4 CPU, 16 GB de RAM y 14 GB de SSD.
- **Un job omitido cuenta como *Success***, aunque sea un check obligatorio.
- **Los workflows con filtro de rutas dejan sus checks en *Pending*** y bloquean el merge.
- **Nombres de check en workflows reutilizables:** la documentación no los especifica, y recomienda nombres de job únicos entre workflows.
- **PRs desde forks:** el `GITHUB_TOKEN` es de solo lectura y los secretos no se pasan.
- **Dependabot** soporta pnpm 12 y `cooldown`.
- **CodeQL** analiza workflows de Actions.

## Decisión

### Workflows

| Workflow | Disparador | Jobs (nombres estables) |
| --- | --- | --- |
| `ci.yml` | `pull_request` → dev, test, prod | `promotion-guard` → `lint`, `typecheck`, `unit-tests`, `prefect-tests`, `graphql-schema`, `terraform-validate`; `build` (tras `typecheck`); `integration-tests` (tras `unit-tests`); `e2e-tests` (tras integración y build); `docker-build` (tras build); **`ci-result`** (`if: always()`, falla si algún job no terminó en `success`) |
| `terraform-plan.yml` | `pull_request` → dev, test, prod (sin filtro de rutas) | `terraform-plan` |
| `deploy-floci.yml` | `push` a dev, test, prod; `workflow_dispatch` (solo esas ramas) | `resolve-environment` → `deploy` → `canary` (llama a `canary-deployment.yml`) |
| `canary-deployment.yml` | `workflow_call`; `workflow_dispatch` | `canary-resolve` → `canary-analysis` |
| `security.yml` | PR, push, semanal, manual | `dependency-review`, `dependency-audit`, `secret-scan`, `codeql (…)`, `trivy-config`, `trivy-images` |

- El plan de Terraform del PR va en su propio workflow con el job `terraform-plan`, y no como workflow reutilizable dentro de `ci.yml`, porque el nombre de check de un workflow reutilizable no está documentado.
- `scripts/ci/check-workflows.py` (en `lint`) comprueba:
  - Actions fijadas por SHA con su versión;
  - nombres de job únicos y `needs` existentes;
  - `permissions` explícitos;
  - ningún dato del PR interpolado en `run:`;
  - que existan los scripts que se invocan.

### Promoción (`scripts/ci/promotion-guard.sh`, con pruebas)

- `feature/*`, `fix/*`, `chore/*` y `docs/*` → `dev`.
- `dev` → `test` y `test` → `prod`, **solo desde este repositorio**: un fork puede tener una rama llamada `dev`.
- Excepción documentada: `dependabot/*` → `dev`, solo desde este repositorio, porque el prefijo de las ramas de Dependabot no es configurable.
- Cualquier otra combinación se rechaza.

### Floci en CI

- **Floci temporal en cada runner:** `scripts/floci/start.sh` con el mismo compose que en local. La imagen se fija por **etiqueta y digest**: `floci/floci:2.4.0@sha256:5ee85db6…`, verificado contra Docker Hub. Escucha solo en `127.0.0.1`, con credenciales ficticias.
- **Antes de iniciar k3s,** `runner-preflight.sh` verifica el socket de Docker, Compose, la memoria, el disco, la creación de redes y el puerto 4566. `free-runner-disk.sh` libera toolchains preinstalados en runners hospedados, porque 14 GB no alcanzan para 6 imágenes, Floci y k3s.
- **EKS en el runner:** `TF_VAR_eks_enabled_override=true`. L-11 es una restricción de la máquina local; el runner tiene 16 GB.

### Terraform

- **PR: plan, nunca apply** (`scripts/ci/terraform-pr-plan.sh`).
  - El estado real no está en el runner.
  - Se **reconstruye** aplicando en el Floci temporal la configuración de la **rama destino** (su commit, con sus propios scripts), que es lo que el despliegue post-merge de esa rama aplicó.
  - El commit del PR se planifica sobre ese estado.
  - Si la rama destino no tiene Terraform, el resumen dice **"plan desde cero"**.
  - Las destrucciones se muestran con aviso.
- **Post-merge** (`scripts/ci/floci-environment.sh`):
  - Floci temporal;
  - bootstrap y global;
  - plan **regenerado** para el commit integrado, publicado y revisado (`terraform-live.sh` rechaza destrucciones);
  - apply de **ese** plan.
- **Aislamiento:** el ambiente sale de la rama (`resolve-environment.sh`, que rechaza cualquier otra) y debe coincidir con el workspace. Un job de `dev` no puede seleccionar `test` ni `prod`.
- **Concurrencia por ambiente:** `deploy-floci-<env>` y `canary-<env>`, con `cancel-in-progress: false` para no cortar un apply. En los PR, la concurrencia es por número de PR con cancelación.
- **Nunca AWS real:** endpoints locales validados y credenciales ficticias.

### Despliegue y canary

- **Imágenes** con etiqueta inmutable `sha-<commit 12>`, porque el árbol del runner está limpio. Nunca `latest`. Se suben al ECR temporal y se despliegan con `k8s-deploy.sh`.
- **Verificación:**
  - humo;
  - `network-verify.sh`: GraphQL por HTTPS a través de API Gateway → VPC Link → NLB → Traefik;
  - `k8s-verify.sh`: NetworkPolicies, SAGA y CloudWatch.
- **Canary** (`scripts/ci/canary-release.sh`), en **otro** ambiente temporal, porque no hay persistencia entre jobs:
  1. la **línea base** (la rama antes del merge) se despliega como estable;
  2. el commit integrado se libera como canary con `canary-demo.sh`;
  3. **Argo Rollouts y el AnalysisTemplate deciden** (ADR-0032); el script solo genera el tráfico que el análisis necesita y espera el veredicto.
- **Resultados posibles:**
  - **pasa:** Argo promueve;
  - **falla:** Argo aborta y el job falla, con el rollback en el informe;
  - **inconcluso:** se aborta, porque sin operador no se promueve;
  - **sin línea base con canary** (primer despliegue): "canary **no ejecutado**", declarado como aviso y en el resumen, nunca como éxito.

### Seguridad de Actions

- `permissions: {}` en cada workflow; `contents: read` y `security-events: write` solo donde hacen falta.
- **Actions fijadas por SHA completo**, con la última versión estable de al menos 14 días:

  | Action | Versión |
  | --- | --- |
  | `actions/checkout` | v7.0.1 |
  | `actions/setup-node` | v7.1.0 |
  | `actions/setup-python` | v7.1.0 |
  | `actions/upload-artifact` | v7.0.2 |
  | `actions/dependency-review-action` | v5.0.0 |
  | `pnpm/action-setup` | v6.1.0 |
  | `hashicorp/setup-terraform` | v4.0.1 (Terraform 1.17.1) |
  | `github/codeql-action` | v4.39.1 |

- **Binarios** fijados y verificados por sha256: Trivy 0.76.1, Gitleaks 8.30.1 y kubectl v1.36.6.
- **`persist-credentials: false`** en todos los checkouts.
- **Datos del PR** (nombres de rama) siempre por `env:`.
- **No se publican secretos:** los artefactos son informes Markdown, sin kubeconfig, credenciales de Floci ni contraseñas de demostración.
- **Ningún runner privilegiado ejecuta código de PRs:** no hay self-hosted, y los despliegues solo corren tras merge a ramas protegidas.

## Alternativas

1. **Runner self-hosted junto al Floci persistente (ADR-0015).** Permitiría planificar y desplegar contra el estado real, pero en un repositorio público ejecutaría código en la máquina del autor; el autor lo descartó.
2. **Exponer el Floci del autor (túnel, IP pública).** Prohibido por el autor y por seguridad.
3. **Plan del PR con estado vacío.** Mostraría "todo se crea" como si fuera el ambiente real: engañoso. Se reconstruye desde la rama destino.
4. **Guardar el estado entre ejecuciones** (artefactos o caché). Sería una persistencia inventada que no corresponde al Floci real y podría restaurar estados de otra ejecución.
5. **Workflows reutilizables para los checks obligatorios.** El nombre del check no está documentado.
6. **Actions de terceros para Trivy y Gitleaks.** Añaden superficie de cadena de suministro; los binarios oficiales con sha256 bastan.

## Consecuencias

- **Positivas:**
  - Cada PR prueba de verdad: integración y E2E contra Floci, plan del ambiente destino sobre un estado reconstruido.
  - Cada merge despliega y verifica un ambiente completo, efímero y reproducible, sin acceso a la máquina del autor.
- **Negativas:**
  - Los ambientes de CI son **temporales**: el despliegue post-merge no actualiza el Floci persistente del autor, que se sigue desplegando a mano con `scripts/floci/*`.
  - El canary corre en un ambiente reconstruido, no en el que desplegó `deploy`.
  - Tiempo: `deploy` y `canary` tardan decenas de minutos cada uno; los runners públicos no consumen minutos de pago.
  - Los workflows **no se ejecutaron en GitHub** al escribir este ADR (no hubo push): ver [L-15](../limitations.md#l-15--cicd-ambientes-efímeros-y-workflows-sin-ejecutar-en-github).
- **Configuración manual:** [github-repository-settings.md](../runbooks/github-repository-settings.md).
