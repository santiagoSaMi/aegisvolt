# Runbook: imágenes, docker compose y Kubernetes (EKS/k3s de Floci)

Decisiones: [ADR-0031](../adr/0031-contenedores-kubernetes-floci.md). Solo credenciales ficticias del emulador; nunca AWS real.

Requisitos:

- Floci en marcha: `scripts/floci/start.sh`, con `FLOCI_TLS_ENABLED=true`;
- Docker con BuildKit, `kubectl`, AWS CLI y `jq`;
- Node 26, para los scripts de tablas.

## 1. Construir las imágenes

```bash
scripts/docker/build-images.sh                       # las 6; imprime la etiqueta (sha-<commit>[-dirty-<epoch>])
scripts/docker/build-images.sh --only web,graphql-api
docker images 'aegisvolt/*'
```

- Las imágenes se llaman `aegisvolt/<app>:<tag>`, con `<app>` = `station-reservation`, `billing-wallet`, `energy-dispatch`, `saga-orchestrator`, `graphql-api` o `web`.
- La primera build descarga todo el lockfile a la caché de BuildKit (`id=aegisvolt-pnpm`); las siguientes la reutilizan.
- Con cambios sin commit la etiqueta lleva `-dirty-<epoch>`. Úsela solo en local.
- Build de una sola imagen a mano: `docker build -f services/billing-wallet/Dockerfile --build-arg GIT_SHA=$(git rev-parse --short=12 HEAD) -t aegisvolt/billing-wallet:dev .` (contexto: la raíz).

## 2. Ejecución local con docker compose

```bash
scripts/local/compose.sh up          # bootstrap 'local' (tablas, flags, Cognito), build y arranque con --wait
scripts/local/compose.sh seed        # 2 estaciones y la billetera de fleet_demo con saldo
scripts/local/compose.sh ps
scripts/local/compose.sh logs -f graphql-api
scripts/local/compose.sh down
AEGISVOLT_TAG=<tag> scripts/local/compose.sh up   # sin reconstruir
```

| URL (solo 127.0.0.1) | Qué |
| --- | --- |
| http://127.0.0.1:8080 | Consola (nginx), usuarios `operador` y `admin` |
| http://127.0.0.1:4000/graphql | graphql-api |
| http://127.0.0.1:4100 … 4103 | orquestador, station, billing, energy (`/health/live`, `/health/ready`) |

- La contraseña ficticia de demostración está en `infra/local/floci/.tmp/identity-local.env`.
- Dentro de la red `aegisvolt-floci` los contenedores llaman a Floci como `http://floci:4566` y entre sí por nombre de servicio.
- No ejecute a la vez `pnpm dev`: usan los mismos puertos.

## 3. Desplegar en el clúster EKS (k3s) de Floci

```bash
scripts/floci/terraform-live.sh dev apply            # log groups, metric filters y alarmas (una vez)
scripts/floci/k8s-deploy.sh dev                      # build + ECR + clúster aegisvolt-dev + bootstrap + rollout + humo
scripts/floci/k8s-deploy.sh dev --tag <tag>          # reutiliza imágenes ya construidas
scripts/floci/k8s-verify.sh dev                      # red, seguridad, SAGA, logs en CloudWatch y métrica
```

- El estado local de cada ambiente queda en `infra/local/floci/.tmp/k8s-<env>/`, ignorado por Git: kubeconfig, credenciales ficticias de Floci para `kubectl`, manifiestos renderizados e informe de verificación.
- `test` y `prod` funcionan igual (`k8s-deploy.sh test`), pero cada clúster k3s consume ~1 GB de RAM.

### Usar kubectl

```bash
export KUBECONFIG=$PWD/infra/local/floci/.tmp/k8s-dev/kubeconfig
set -a; source infra/local/floci/.tmp/k8s-dev/kube-credentials.env; set +a   # access key emitida por Floci (ficticia)

kubectl -n aegisvolt get deploy,svc,pods,netpol
kubectl -n aegisvolt port-forward svc/web 8080:80            # consola en http://127.0.0.1:8080
kubectl -n aegisvolt logs deploy/saga-orchestrator-service -f
kubectl -n aegisvolt describe pod -l app.kubernetes.io/name=graphql-api
kubectl -n aegisvolt get events --sort-by=.lastTimestamp | tail -20
kubectl -n aegisvolt exec deploy/graphql-api -- wget -qO- http://billing-wallet-service/health/ready
kubectl -n logging logs ds/fluent-bit --tail=50
```

### Actualizar, revertir y detener

```bash
scripts/floci/k8s-deploy.sh dev --tag <nuevo-tag>             # rolling update (maxUnavailable 0)
kubectl -n aegisvolt rollout history deploy/graphql-api
kubectl -n aegisvolt rollout undo deploy/graphql-api           # vuelve a la revisión anterior
kubectl -n aegisvolt rollout restart deploy/graphql-api
```

Para **borrar el clúster** (destructivo; solo con autorización): `aws eks delete-cluster --name aegisvolt-dev`. Luego, `docker rm -f floci-aws-eks-aegisvolt-dev` y `docker volume rm floci-aws-eks-aegisvolt-dev`, porque Floci conserva el contenedor y el volumen de k3s. Los datos de DynamoDB y Cognito del ambiente viven en Floci y no se borran con el clúster.

### Canary de graphql-api

`k8s-deploy.sh` también instala la plataforma de clúster: Argo Rollouts v1.10.1 y Traefik v3.7.16, con los manifiestos oficiales verificados por sha256 (`scripts/k8s/vendor-platform.sh`).

- graphql-api se despliega como `Rollout` y el script espera a que esté `Healthy`.
- Con `--no-wait-canary` no se espera.
- Promoción, rollback y evidencias: [canary-demo.md](canary-demo.md).
- Si el clúster no arranca tras reiniciar Docker, ver [L-10](../limitations.md#l-10--el-clúster-k3s-de-floci-no-arranca-si-su-contenedor-cambia-de-ip).

## 4. Troubleshooting

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| Pods `0/1 Running`, *readiness* con `context deadline exceeded` | El pod no llega a Floci. En esta fase la causa fue que las NetworkPolicies comunes estaban fuera del namespace `aegisvolt`, lo que bloqueaba el DNS | `kubectl -n aegisvolt get netpol` debe listar `default-deny-all`, `allow-dns-egress`, `allow-aws-egress` y `allow-floci-egress`. Probar con `kubectl exec … -- nslookup floci` y `wget http://floci:4566/_floci/health` |
| `nslookup: … Connection refused` | DNS bloqueado por política (kube-router rechaza) | Revisar `allow-dns-egress` y la etiqueta `k8s-app=kube-dns` de CoreDNS |
| Floci responde por IP pero no por `floci` | Falta el Service o el EndpointSlice `floci`, o la IP cambió (Floci se recreó) | Volver a desplegar: el script inyecta la IP actual de Floci |
| El contenedor reinicia con `ConfigValidationError` | Variable de entorno inválida; el servicio no arranca con configuración incoherente | Leer el log `fatal`, que nombra la variable. Ejemplo real: `SHUTDOWN_GRACE_MS` debe superar `HTTP_REQUEST_TIMEOUT_MS` |
| La web no arranca: log `fatal … APP_ENV`, `COGNITO_CLIENT_ID` o upstream | Falta configuración (lo valida `10-validate-env.sh`) | Revisar el ConfigMap `web-config` y `aegisvolt-identity` |
| `CreateContainerConfigError` | No existe el ConfigMap `aegisvolt-identity` o el Secret `floci-aws` | Volver a ejecutar `k8s-deploy.sh` (los crea) |
| `ImagePullBackOff` | La etiqueta no está en el ECR de Floci, o el registry `floci-aws-ecr-registry` está detenido | `aws ecr describe-images --repository-name aegisvolt/<app>`; `docker start floci-aws-ecr-registry` |
| `kubectl`: `provide credentials` | Se usaron `test/test` | Cargar `kube-credentials.env` (access key emitida por Floci) |
| UNAUTHENTICATED en GraphQL | `COGNITO_ISSUER` no coincide con el `iss` (con TLS: `https://floci:4566/<pool>`) | Revisar `aegisvolt-identity`; el bootstrap lo genera con https |
| Faltan logs en CloudWatch | Log group inexistente (Fluent Bit no los crea) o falta la etiqueta `app.kubernetes.io/part-of=aegisvolt` | `terraform-live.sh <env> apply`; `kubectl -n logging logs ds/fluent-bit` |
| `docker build`: `ERR_PNPM_UNEXPECTED_STORE` | `pnpm run` verificó dependencias con otro store | Los Dockerfiles fijan `pnpm config set store-dir` global; no quitarlo |
| Pulls de Docker fallan con `docker-credential-desktop` | `credsStore` heredado de Docker Desktop | Los scripts usan un `DOCKER_CONFIG` aislado (`infra/local/floci/.tmp/docker-config`) |
