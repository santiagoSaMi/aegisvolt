# Guía de instalación y troubleshooting

Instalación de las herramientas, desde cero, en Linux x86_64, sin `sudo`. Las versiones son las verificadas en el proyecto. Al final hay una tabla de problemas reales encontrados durante el desarrollo, con su solución.

## 1. Herramientas

| Herramienta | Versión verificada | Uso | Instalación |
| --- | --- | --- | --- |
| Node.js | 26 (fijada en `.nvmrc`) | Apps, servicios y scripts | `nvm install && nvm use` en la raíz |
| pnpm | 12.18.0 (`packageManager`) | Monorepo | `npm install -g pnpm@12.18.0` (Node 26 ya no trae corepack) |
| Docker Engine + Compose v2 | 29.9.3 | Floci, imágenes, k3s | Usuario en el grupo `docker` |
| AWS CLI v2 | 2.40.2 | Consultas a Floci | Zip oficial con firma GPG → `./aws/install --install-dir ~/.local/aws-cli --bin-dir ~/.local/bin` |
| Terraform | 1.17.1 (CI y `required_version >= 1.12`) | IaC | Zip de releases.hashicorp.com verificado con `SHA256SUMS` → `~/.local/bin` |
| kubectl | v1.37.2 | Clúster k3s | `dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl` + `.sha256` → `~/.local/bin` |
| jq | 1.8.1 | Scripts | Binario de GitHub releases verificado con `sha256sum.txt` → `~/.local/bin` |
| Python | 3.12 con `venv` | Prefect | El del sistema; `python3 -m venv prefect/.venv` |

- `~/.local/bin` debe estar en el `PATH`.
- `pnpm-workspace.yaml` tiene `engineStrict: true`: `pnpm install` falla con una versión de Node distinta de la 26.
- **Recursos:** Floci consume poco en reposo. Cada clúster k3s añade ~1,3 GB. Con 7,5 GB de RAM solo cabe un clúster local (L-11).

## 2. Instalación paso a paso

```bash
git clone <url-del-repositorio> aegisvolt && cd aegisvolt
nvm install && nvm use
npm install -g pnpm@12.18.0
pnpm install
pnpm check                                         # formato, lint, typecheck, unitarias, build

scripts/floci/start.sh                             # Floci 2.4.0
scripts/floci/smoke-test.sh                        # verificación del emulador
REQUIRE_INTEGRATION=true pnpm test:integration     # DynamoDB y GraphQL
REQUIRE_INTEGRATION=true pnpm test:e2e             # SAGA, GraphQL con Cognito y consola en Chromium

cd prefect && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && .venv/bin/pytest && cd ..
```

Para la infraestructura completa (Terraform y el clúster de `dev`), sigue [local-development.md §D](local-development.md#d-ambiente-dev-en-kubernetes-eksk3s-de-floci).

## 3. Verificación rápida del entorno

```bash
node --version                 # v26.x
pnpm --version                 # 12.18.0
terraform version              # Terraform v1.17.1
docker version --format '{{.Server.Version}}'
aws --version
kubectl version --client
scripts/floci/status.sh        # Floci healthy, versión 2.4.0, storage persistent
```

## 4. Troubleshooting

### Toolchain y build

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `pnpm install`: `Unsupported engine` | Node distinto de 26 | `nvm use` |
| Una app en `dev` no ve un cambio de `packages/*` | Los paquetes se consumen compilados | `pnpm build:packages` |
| `docker build`: `ERR_PNPM_UNEXPECTED_STORE` | `pnpm run` verificó dependencias con otro store | Los Dockerfiles fijan `store-dir`; no lo quites |
| `docker build`: `ERR_PNPM_NO_OFFLINE_META` en `pnpm deploy` | `--offline` sin los metadatos que exige la política de cadena de suministro de pnpm 12 | Ya corregido: `deploy` sin `--offline` en los Dockerfiles |
| Pull de Docker: `docker-credential-desktop` no existe | `credsStore` heredado de Docker Desktop | Los scripts usan un `DOCKER_CONFIG` aislado. Solución permanente: quitar la línea de `~/.docker/config.json` |

### Pruebas

| Síntoma | Causa | Solución |
| --- | --- | --- |
| Integración o E2E "skipped" | Floci no responde y falta `REQUIRE_INTEGRATION=true` | `scripts/floci/start.sh` y repetir con la variable |
| E2E de la consola falla al abrir Chromium | `playwright-core` no descarga navegadores: usa el Chromium de `~/.cache/ms-playwright` | Ver [tests/e2e/README.md](../../tests/e2e/README.md) |
| Prefect: `database is locked` | Servidor efímero de Prefect | Arranca un `prefect server start` dedicado con su `PREFECT_HOME` ([observability.md §6.2](observability.md#62-si-el-servidor-de-prefect-falla-con-database-is-locked)) |

### Floci y Terraform

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `terraform init`: `NoSuchBucket` | El bucket de estado no existe | `scripts/floci/terraform-bootstrap.sh apply` |
| `Error acquiring the state lock` (412 `PreconditionFailed`) | Otro `plan` o `apply` tiene el `.tflock` | Espera a que termine. **No** fuerces el desbloqueo si hay otro proceso vivo |
| El plan rechaza `envs/prod.tfvars` en el workspace `test` | Precondición `workspace_guard` | Usa el `tfvars` del workspace seleccionado (`terraform-live.sh <env>` lo hace solo) |
| El script rechaza el plan por destrucciones | Guarda de `terraform-live.sh` | Revisa la lista ([terraform.md §6](terraform.md#6-cambios-de-red-que-recrean-recursos)). `--allow-destroy` solo con autorización |
| Aviso `protocol_version` en `aws_lb_target_group` | Floci devuelve el atributo en un target group TCP | Inofensivo (L-14) |

### Kubernetes

| Síntoma | Causa | Solución |
| --- | --- | --- |
| k3s no arranca: `failed to find interface with specified node ip` | El contenedor cambió de IP al reiniciar | [L-10](../limitations.md#l-10--el-clúster-k3s-de-floci-no-arranca-si-su-contenedor-cambia-de-ip): reconectarlo con su IP original |
| `localhost:65xx` *connection refused* tras `k8s-deploy.sh` | El contenedor k3s terminó (`Exited (1)`). Ocurrió de forma intermitente en un runner de GitHub (L-19) | `docker logs floci-aws-eks-aegisvolt-<env>`. En CI, reintentar el job |
| Pods `0/1`, readiness con `context deadline exceeded` | NetworkPolicies o DNS | [kubernetes.md §4](kubernetes.md#4-troubleshooting) |
| `ImagePullBackOff` | La etiqueta no está en ECR o el registry está detenido | `docker start floci-aws-ecr-registry` |
| UNAUTHENTICATED en GraphQL | `COGNITO_ISSUER` no coincide con el `iss` del token | Revisa el ConfigMap `aegisvolt-identity` (debe usar `https://floci:4566/<pool>`) |
| El Rollout queda `Paused` (Inconclusive) | Menos de 30 operaciones del canary en la ventana | Genera tráfico o aborta ([canary-rollback.md](canary-rollback.md#qué-ocurre-con-una-muestra-insuficiente)) |
| Quedan `kubectl port-forward` vivos después de un script | `k8s-verify.sh` y `canary-demo.sh` no los cierran (L-20) | `ps -eo pid,args \| awk '$2 ~ /kubectl$/ && /port-forward/ {print $1}' \| xargs -r kill`. No uses `pkill -f`: puede coincidir con tu propia shell |

### GitHub Actions

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `Merging is blocked` con todos los checks en verde | Un check requerido no se ejecutó en ese PR, o el ruleset exige un método de merge deshabilitado en el repositorio | [github-repository-settings.md](github-repository-settings.md) §1 y §2 |
| "Require linear history" bloquea el merge de `dev → test` | Una promoción necesita un merge commit | No actives *linear history* en `test` ni en `prod` |
| Los jobs `codeql` fallan al subir resultados | El *default setup* de CodeQL está activo y choca con el *advanced setup* del workflow | Desactívalo en Settings → Code security |
| `canary-analysis`: "canary no ejecutado" | La línea base no tiene el canary de Argo o no se puede construir | Es el comportamiento esperado (L-15) |
