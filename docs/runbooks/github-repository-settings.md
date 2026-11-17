# Runbook: configuración manual del repositorio en GitHub

Escribir los workflows **no** configura el repositorio. Rulesets, protección de ramas, environments, métodos de merge y opciones de seguridad se configuran a mano en la interfaz de GitHub, con una cuenta propietaria. Este runbook dice exactamente qué marcar. Diseño: [ADR-0035](../adr/0035-cicd-github-actions-runners-hospedados-floci-efimero.md).

Contexto: repositorio **público**, plan **GitHub Free**, solo runners hospedados por GitHub. Los environments `dev`, `test` y `prod` **ya existen**; aquí solo se ajustan sus reglas.

> Ningún paso de este runbook lo ejecutó Claude: no hubo `git push` ni cambios de configuración remota. Después de configurarlo, verifíquelo con la [sección 7](#7-pruebas-de-la-configuración).

## 1. General → Pull Requests

**Settings → General → Pull Requests:**

| Opción | Valor | Motivo |
| --- | --- | --- |
| Allow merge commits | ✅ | Promociones `dev → test` y `test → prod`: con *squash*, las ramas divergen y cada promoción posterior genera conflictos ([07-cicd](../architecture/07-cicd.md)) |
| Allow squash merging | ✅ | `feature/* → dev`: un commit por cambio |
| Allow rebase merging | ❌ | No se usa |
| Automatically delete head branches | ✅ | Borra `feature/*` tras el merge. `dev` y `test` también son ramas *head* en las promociones; la documentación dice que las reglas pueden impedir el borrado automático ("Branch protection rules and repository rules can also prevent branches being automatically deleted"). Con **Restrict deletions** (sección 2) no deben borrarse: **verifíquelo** tras la primera promoción (sección 7.3) |

**Settings → General → Default branch:** `dev`.

Los rulesets exigen después el método de merge **por rama** (squash en `dev`, merge en `test` y `prod`). Si el repositorio deshabilita un método que un ruleset exige, GitHub bloquea el merge; por eso deben quedar habilitados los dos.

## 2. Rulesets de `dev`, `test` y `prod`

**Settings → Rules → Rulesets → New ruleset → New branch ruleset.** Cree **tres** rulesets, uno por rama, porque cada uno exige un método de merge distinto.

| Campo | `dev` | `test` | `prod` |
| --- | --- | --- | --- |
| Ruleset name | `protect-dev` | `protect-test` | `protect-prod` |
| Enforcement status | Active | Active | Active |
| Bypass list | **vacía** | **vacía** | **vacía** |
| Target branches → Add target → Include by pattern | `dev` | `test` | `prod` |
| Restrict deletions | ✅ | ✅ | ✅ |
| Block force pushes | ✅ | ✅ | ✅ |
| Require a pull request before merging | ✅ | ✅ | ✅ |
| · Required approvals | 0 (ver nota) | 0 | 0 |
| · Dismiss stale pull request approvals when new commits are pushed | ✅ | ✅ | ✅ |
| · Require conversation resolution before merging | ✅ | ✅ | ✅ |
| · Merge method (allowed) | **Squash** | **Merge** | **Merge** |
| Require status checks to pass | ✅ (lista abajo) | ✅ | ✅ |
| · Require branches to be up to date before merging | ✅ | ✅ | ✅ |

- **Push directo:** con *Require a pull request before merging* y la bypass list vacía, todo cambio a la rama debe llegar por PR. Un `git push origin dev` es rechazado (`GH013: Repository rule violations`).
- **Aprobaciones = 0:** en un proyecto individual, el autor no puede aprobar su propio PR, así que 1 aprobación bloquearía todo merge. Si hay otro colaborador con permiso de escritura, súbalo a 1 en `test` y `prod`.
- **Plan Free:** la documentación garantiza la protección de ramas en repositorios públicos de GitHub Free; para los *rulesets* la página es ambigua. Si **Settings → Rules → Rulesets** no está disponible, use **Settings → Branches → Add branch protection rule** con las mismas opciones:
  - Require a pull request before merging;
  - Require status checks to pass;
  - Require conversation resolution;
  - **Do not allow bypassing the above settings**;
  - Allow force pushes ❌ y Allow deletions ❌.

  La protección clásica no exige el método de merge por rama: hay que respetarlo al fusionar.

### Required status checks (nombres reales de los jobs)

Los checks solo aparecen en el buscador de **Add checks** después de haberse ejecutado al menos una vez. Abra primero un PR de prueba (sección 7.1) y luego agréguelos. Los nombres son los `name:` de los jobs y son únicos entre todos los workflows (lo comprueba `scripts/ci/check-workflows.py`).

| Check | Workflow | Qué valida |
| --- | --- | --- |
| `ci-result` | `ci` | **Imprescindible.** Un job omitido cuenta como *Success* para GitHub ("A job that is skipped will report its status as Success"); `ci-result` falla si algún job de CI no terminó en `success` |
| `promotion-guard` | `ci` | Origen → destino permitido |
| `lint` | `ci` | Prettier, ESLint, dependency-cruiser, workflows |
| `typecheck` | `ci` | TypeScript estricto |
| `unit-tests` | `ci` | Pruebas unitarias del monorepo |
| `prefect-tests` | `ci` | ruff, mypy y pytest de Prefect |
| `graphql-schema` | `ci` | Snapshot del esquema, operaciones de la consola y cambios incompatibles |
| `build` | `ci` | Build de todos los paquetes |
| `integration-tests` | `ci` | DynamoDB y GraphQL contra Floci temporal |
| `e2e-tests` | `ci` | SAGA, GraphQL con Cognito y consola en Chromium |
| `docker-build` | `ci` | 6 imágenes con etiqueta `sha-<commit>` |
| `terraform-validate` | `ci` | fmt, validate, provider fijado, sin endpoints reales |
| `terraform-plan` | `terraform-plan` | Plan del workspace de la rama destino |
| `dependency-review` | `security` | Dependencias nuevas con vulnerabilidades altas |
| `dependency-audit` | `security` | `pnpm audit` (alta o crítica) |
| `secret-scan` | `security` | Gitleaks sobre todo el historial |
| `codeql (javascript-typescript)`, `codeql (python)`, `codeql (actions)` | `security` | Análisis de código |
| `trivy-images` | `security` | Vulnerabilidades CRITICAL con parche en las imágenes |

`trivy-config` es informativo: no lo marque como obligatorio. Tampoco los jobs de despliegue (`deploy`, `canary-analysis`), que corren después del merge.

## 3. Environments `dev`, `test` y `prod` (ya existen)

**Settings → Environments → `<ambiente>`.** Los workflows `deploy-floci` y `canary-deployment` ya los referencian por nombre. No cree otros: si un workflow referencia un environment inexistente, GitHub lo crea, y por eso los workflows validan la rama antes de usarla.

| Opción | `dev` | `test` | `prod` |
| --- | --- | --- | --- |
| Deployment branches and tags | Selected branches and tags → **Add deployment branch or tag rule** → `dev` | → `test` | → `prod` |
| Required reviewers | — | — | Solo si hay **otro** revisor autorizado (ver abajo) |
| Prevent self-review | — | — | ✅ (si hay revisores) |
| Allow administrators to bypass configured protection rules | — | — | ❌ (desmarcar) |
| Secrets / variables | Ninguno | Ninguno | Ninguno |

- **Aprobación de producción:**
  - *Required reviewers* con *Prevent self-review* solo tiene sentido si existe una segunda persona autorizada. Si usted es el único revisor, con *Prevent self-review* el despliegue de `prod` quedaría bloqueado para siempre.
  - Opciones honestas para un proyecto individual: (a) no exigir revisores en `prod` y apoyarse en el PR obligatorio `test → prod`; (b) exigirse a sí mismo **sin** *Prevent self-review*, lo que solo añade una pausa manual consciente.
  - La documentación indica que basta la aprobación de uno de los revisores ("Only one of the required reviewers needs to approve the job for it to proceed").
- **Sin secretos:** las credenciales de Floci son ficticias y están en el repositorio (`test`/`test`). No agregue credenciales de AWS reales a ningún environment (CLAUDE.md).

## 4. Actions

**Settings → Actions → General:**

| Opción | Valor |
| --- | --- |
| Actions permissions | *Allow \<cuenta\>, and select non-\<cuenta\>, actions and reusable workflows* → marcar *Allow actions created by GitHub* y en la lista: `pnpm/action-setup@*`, `hashicorp/setup-terraform@*` |
| Approval for running fork pull request workflows from contributors | **Require approval for all external contributors** |
| Workflow permissions | **Read repository contents and packages permissions** (cada job pide lo suyo con `permissions:`) |
| Allow GitHub Actions to create and approve pull requests | ❌ |

Todas las Actions están fijadas por SHA completo en los workflows. Sin runners self-hosted: este repositorio público no debe registrar ninguno (ADR-0035).

## 5. Seguridad del código

**Settings → Security → Advanced Security** (o *Code security*, según la interfaz):

| Opción | Valor | Nota |
| --- | --- | --- |
| Dependency graph | ✅ | Lo necesita `dependency-review` |
| Dependabot alerts | ✅ | |
| Dependabot security updates | ✅ | Las versiones las propone `.github/dependabot.yml` contra `dev` (cooldown de 14 días) |
| Secret scanning + Push protection | ✅ | Disponible en repositorios públicos |
| Code scanning → CodeQL | **No** active *Default setup* | El workflow `security` hace un *advanced setup* y los dos se excluyen |

## 6. Qué hace cada workflow (resumen)

| Workflow | Disparador | Runner | Efecto |
| --- | --- | --- | --- |
| `ci` | PR → dev, test, prod | hospedado | Checks; Floci temporal para integración y E2E |
| `terraform-plan` | PR → dev, test, prod | hospedado | Plan del workspace de la rama destino sobre estado reconstruido. **Nunca apply** |
| `security` | PR, push a ramas protegidas, semanal | hospedado | Dependencias, secretos, CodeQL, Trivy |
| `deploy-floci` | push (merge) a dev, test, prod; manual en esas ramas | hospedado, environment = rama | Floci **temporal**: plan regenerado + apply, imágenes `sha-<commit>`, despliegue en k3s, verificaciones. No toca el Floci persistente |
| `canary-deployment` | llamado por `deploy-floci`; manual | hospedado, environment = rama | Canary con Argo Rollouts: línea base estable → commit como canary |

## 7. Pruebas de la configuración

### 7.1 PR de una feature

```bash
git switch dev && git pull
git switch -c feature/prueba-ci
echo "<!-- prueba -->" >> docs/runbooks/github-repository-settings.md
git commit -am "docs: prueba del pipeline" && git push -u origin feature/prueba-ci
gh pr create --base dev --head feature/prueba-ci --title "docs: prueba del pipeline" --body "Prueba de CI"
gh pr checks --watch
```

Esperado:

- todos los checks de la tabla de la sección 2 en verde;
- en el resumen de `terraform-plan`, "no se genera plan" (no toca la infraestructura);
- el botón de merge solo ofrece **Squash and merge**.

**Pruebas negativas:**

```bash
gh pr create --base test --head feature/prueba-ci --title "debe fallar"   # promotion-guard: "test solo recibe PRs desde dev"
git push origin HEAD:dev                                                  # rechazado: GH013 (requiere PR)
git push --force origin dev                                               # rechazado: GH013 (force push bloqueado)
```

Cierre el PR inválido sin fusionar.

### 7.2 Merge a `dev`

- **Squash and merge** → **Actions → deploy-floci** en `dev`:
  - `resolve-environment` → `dev`;
  - `deploy`: plan regenerado y aplicado, imágenes `sha-<commit>`, informe de red con GraphQL por HTTPS y verificación K8s;
  - `canary / canary-analysis` (línea base = `dev` antes del merge).
- **Evidencias:** resumen del job y artefactos `deploy-dev-reports` y `canary-dev`.

### 7.3 Promoción `dev → test`

```bash
gh pr create --base test --head dev --title "release: dev → test" --body "Promoción"
gh pr checks --watch
```

- El `terraform-plan` muestra el diff del workspace `test` sobre el estado reconstruido de `test` (o "desde cero" si `test` aún no tiene Terraform).
- Fusione con **Create a merge commit**.
- Confirme que la rama `dev` **sigue existiendo** (`git ls-remote origin dev`): *Restrict deletions* debe impedir el borrado automático.
- `deploy-floci` corre con environment `test`.

### 7.4 Promoción `test → prod`

```bash
gh pr create --base prod --head test --title "release: test → prod" --body "Promoción"
```

- Mismos checks; merge commit.
- `deploy-floci` en `prod`: si configuró revisores, el job `deploy` espera la aprobación en **Actions → run → Review deployments**.
- Una PR `dev → prod` debe ser rechazada por `promotion-guard`.

## 8. Lista de verificación

- [ ] Merge commits y squash habilitados; rebase deshabilitado; borrado automático de ramas activado; rama por defecto `dev`.
- [ ] Rulesets `protect-dev` (squash), `protect-test` y `protect-prod` (merge), activos, sin bypass, con los checks de la sección 2 (incluido `ci-result`).
- [ ] Environments: ramas permitidas = la propia; `prod` sin bypass de administradores; revisores solo si hay otro revisor.
- [ ] Actions: aprobación para colaboradores externos; token de solo lectura por defecto; sin runners self-hosted.
- [ ] Dependabot, secret scanning con push protection y sin CodeQL *default setup*.
- [ ] Pruebas 7.1–7.4 ejecutadas y evidencias revisadas.
