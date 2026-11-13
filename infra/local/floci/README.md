# Floci — emulador AWS local de AegisVolt

[Floci](https://floci.io/) es el emulador AWS local **obligatorio** del proyecto. Desarrollo, pruebas y CI local apuntan a Floci; **nunca** a una cuenta AWS real.

> Verificado el 2026-11-12 con **Floci 2.4.0** (`floci/floci:2.4.0`), Floci CLI 0.4.0, Docker 29.9.3, Linux Mint 22.3 (x86_64). Ver la [matriz de servicios](#matriz-de-servicios).

## Contenido

| Ruta | Propósito |
| --- | --- |
| `docker-compose.yml` | Servicio Floci con versión fijada, puerto en loopback, persistencia y socket de Docker |
| `config/floci.env` | Variables del **servidor** Floci (sin secretos) |
| `config/aws-local.env` | Variables del **cliente** (AWS CLI/SDK): endpoint local y credenciales ficticias |
| `terraform-check/` | Configuración Terraform mínima para verificar provider y backend S3 contra Floci |
| `data/` | Estado persistente de Floci (**ignorado por Git**) |
| `.tmp/` | Temporales: planes, kubeconfigs de prueba, `DOCKER_CONFIG` aislado (**ignorado por Git**) |
| `../../../scripts/floci/` | `start.sh`, `stop.sh`, `status.sh`, `smoke-test.sh`, `terraform-check.sh`, `lib.sh` |

## Requisitos

| Herramienta | Versión verificada | Instalación (sin sudo) |
| --- | --- | --- |
| Docker Engine | 29.9.3 (Floci exige ≥ 23.0) + Compose v2 | usuario en el grupo `docker` |
| Floci CLI (opcional) | 0.4.0 | `curl -fsSL https://floci.io/install.sh -o install.sh` → revisar → `FLOCI_CLI_VERSION=0.4.0 FLOCI_INSTALL_DIR=$HOME/.local/bin sh install.sh` (verifica sha256) |
| AWS CLI v2 | 2.40.2 | zip oficial + firma GPG → `./aws/install --install-dir ~/.local/aws-cli --bin-dir ~/.local/bin` |
| Terraform | 1.17.2 (mín. 1.10 por `use_lockfile`) | zip de releases.hashicorp.com verificado con `SHA256SUMS` → `~/.local/bin` |
| kubectl | v1.37.2 | `dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl` + `.sha256` → `~/.local/bin` |
| jq | 1.8.1 | binario de GitHub releases verificado con `sha256sum.txt` → `~/.local/bin` |

`~/.local/bin` debe estar en `PATH`. Recursos: Floci en reposo consume poco; un clúster EKS (k3s) añade ~1 GB de RAM.

## Uso diario

```bash
scripts/floci/start.sh        # idempotente: si ya está healthy no hace nada
scripts/floci/status.sh       # contenedor, health, versión, modo de storage, contenedores hermanos
scripts/floci/stop.sh         # docker compose stop: conserva contenedor, red y datos

# Usar AWS CLI contra Floci en la shell actual
set -a; source infra/local/floci/config/aws-local.env; set +a
aws s3 ls
```

- **Endpoint:** `http://localhost:4566` (publicado solo en `127.0.0.1`).
- **Health:** `GET http://localhost:4566/_floci/health` → JSON con `version`, `edition` y estado de cada servicio.
- **Región / cuenta:** `us-east-1`, cuenta `000000000000`.
- **Credenciales:** `test` / `test` (ficticias). `config/aws-local.env` además fija `AWS_CONFIG_FILE=/dev/null` y `AWS_SHARED_CREDENTIALS_FILE=/dev/null` para que nunca se use un perfil real de `~/.aws`.
- `lib.sh#assert_local_endpoint` aborta cualquier script si `AWS_ENDPOINT_URL` no es local o si la access key no es la ficticia.

Equivalente con Floci CLI (no usado por los scripts): `floci status`, `floci doctor`, `floci env`. Los scripts usan Docker Compose porque fijan la versión de la imagen, el modo de persistencia y los montajes de forma versionada (ver [ADR-0001](../../../docs/adr/0001-floci-emulador-aws-local.md)).

## Persistencia

| Variable | Valor | Motivo |
| --- | --- | --- |
| `FLOCI_STORAGE_MODE` | `persistent` | La imagen publicada usa `memory` por defecto (no sobrevive reinicios). `persistent` escribe a disco de forma síncrona en cada cambio; `hybrid` puede perder el último lote al reiniciar. |
| `FLOCI_STORAGE_PERSISTENT_PATH` | `/app/data` | Montado desde `infra/local/floci/data` (bind mount). |
| `FLOCI_STORAGE_HOST_PERSISTENT_PATH` | ruta absoluta de `data/` | Ruta del host para bind mounts de contenedores hermanos; la exporta `start.sh`. |

- El contenedor corre como **tu UID:GID** (+ GID del socket Docker), así los archivos de `data/` son tuyos y no de root.
- **Verificado:** un bucket S3 con objeto, una tabla DynamoDB con ítem y un log group sobreviven a `stop.sh` + `start.sh`.
- **Reiniciar desde cero** (destructivo, manual y consciente): `scripts/floci/stop.sh` y luego mover/borrar `infra/local/floci/data/`. Ningún script lo hace. `floci reset` / `floci stop` del CLI pueden borrar estado: no se usan.

## Terraform

`terraform-check/` valida la integración antes de construir la IaC real.

```bash
scripts/floci/terraform-check.sh          # fmt -check, init, workspace floci-check, validate, plan
scripts/floci/terraform-check.sh --apply  # + apply del plan guardado (recursos aegisvolt-floci-check-*)
```

**Provider** (`main.tf`): credenciales `test`, `skip_credentials_validation`, `skip_metadata_api_check`, `skip_requesting_account_id`, `s3_use_path_style = true` y un `endpoints {}` con **cada** servicio usado (`dynamodb`, `logs`, `s3`, `sts`). Un servicio omitido iría al endpoint real de AWS. `var.floci_endpoint` tiene una `validation` que solo acepta `http://localhost|127.0.0.1`.

**Backend S3** (`backend.floci.hcl`, configuración parcial en `init -backend-config=...`): se configura **por separado**, porque el backend no hereda la configuración del provider. Usa `endpoints = { s3 = ... }` (la sintaxis vigente; `endpoint`/`dynamodb_endpoint` de la guía de Floci son atributos deprecados), `use_path_style = true`, flags `skip_*` y `use_lockfile = true` (bloqueo nativo en S3 con `.tflock`, sin tabla DynamoDB).

**Evidencia** (workspace `floci-check`):
- El estado queda en `s3://aegisvolt-tfstate-floci-check/env:/floci-check/floci-check/terraform.tfstate`.
- El bucket tiene versionado activo: tras el apply hay **2 versiones** del tfstate.
- El lock `.tflock` se crea y se libera.
- El `apply` creó `aegisvolt-floci-check-floci-check` (DynamoDB, `ACTIVE`) y `/aegisvolt/floci-check/floci-check` (Logs, retención 7d).
- Un segundo `plan -detailed-exitcode` devolvió 0, es decir, sin drift.

El bucket de estado de esta prueba se crea con AWS CLI porque no puede gestionarse con el mismo estado que almacena. La fase de IaC lo reemplazará por un módulo *bootstrap* de Terraform.

Esos dos recursos de prueba **siguen creados** en Floci, porque el script nunca ejecuta `destroy`. Para quitarlos, con autorización: `cd infra/local/floci/terraform-check && terraform workspace select floci-check && terraform destroy` (con las variables de `config/aws-local.env` cargadas).

## Kubernetes / EKS

Floci implementa EKS en **modo real** levantando **un contenedor k3s (`rancher/k3s`) por clúster** a través del socket de Docker. **No es un EKS administrado**: es k3s detrás de la API de EKS.

```bash
set -a; source infra/local/floci/config/aws-local.env; set +a
aws iam create-role --role-name eks-role --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"eks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
SUBS=$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')
aws eks create-cluster --name demo --kubernetes-version 1.36 --role-arn arn:aws:iam::000000000000:role/eks-role --resources-vpc-config subnetIds=$SUBS

# test/test es RECHAZADO por el webhook IAM (otorga cluster-admin): usar una access key emitida por Floci
aws iam create-user --user-name kube-admin
read AK SK < <(aws iam create-access-key --user-name kube-admin --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK aws eks update-kubeconfig --name demo --kubeconfig ./demo.kubeconfig
AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK KUBECONFIG=./demo.kubeconfig kubectl get nodes
```

Comportamiento verificado:
- Clúster `ACTIVE` en ~10 s. El API server queda en `https://localhost:6500` (rango 6500–6599).
- Nodo `Ready` con `v1.36.0+k3s1`.
- Un `Deployment` + `Service` ClusterIP es alcanzable por DNS desde otro pod.
- Un pod puede descargar su imagen desde el **ECR de Floci** (`localhost:4566/000000000000/us-east-1/<repo>:<tag>`).

Diferencias con EKS real:
- Todos los node groups comparten un único nodo k3s.
- Los add-ons son solo metadatos.
- `UpdateClusterConfig`, `UpdateClusterVersion` y `UpdateNodegroup*` no están implementados.
- El puerto del API server se publica en `0.0.0.0` del host, no solo en loopback.
- En modo `persistent`, `delete-cluster` **no elimina** el volumen Docker `floci-aws-eks-<nombre>`. El smoke test lo borra explícitamente.

## ECR

- Con `FLOCI_SERVICES_ECR_URI_STYLE=path` las URIs son `localhost:4566/<cuenta>/<región>/<repo>`. La documentación lo recomienda con el image store de containerd, que es el de Docker 29.
- Login: `aws ecr get-login-password | docker login --username AWS --password-stdin localhost:4566`.
- El backend es un contenedor `floci-aws-ecr-registry` (`registry:2`) en `127.0.0.1:5100`, que **sigue en ejecución** tras `stop.sh`.

## Smoke tests

```bash
scripts/floci/smoke-test.sh               # S3, DynamoDB, Logs, API Gateway, VPC/VPCE, ECR
scripts/floci/smoke-test.sh --with-eks    # + EKS (~2 min en total)
scripts/floci/smoke-test.sh --only ecr    # una sola prueba
scripts/floci/smoke-test.sh --keep        # no limpia (inspección manual)
```

Cada ejecución usa el prefijo `aegisvolt-smoke-<id>` y el `trap EXIT` elimina **solo** esos recursos. El login de ECR usa un `DOCKER_CONFIG` temporal, así que no toca `~/.docker`.

## Matriz de servicios

Floci **2.4.0**, ejecución completa `smoke-test.sh --with-eks` + `terraform-check.sh --apply`, 2026-11-12.

| Servicio | Estado | Evidencia |
| --- | --- | --- |
| S3 | **funcional** | create/list bucket. Versionado `Enabled`: 2 versiones de `env:/dev/terraform.tfstate` y versión previa recuperada con `--version-id`. Persiste tras reinicio. |
| DynamoDB | **funcional** | create-table, put/get/query. Escritura condicional duplicada rechazada con `ConditionalCheckFailedException`, base de la idempotencia de la SAGA. |
| CloudWatch Logs | **funcional** | Log group `/aegisvolt/...` con retención de 7 días. `put-log-events`, `get-log-events` y `filter-log-events` por `correlation_id`. |
| API Gateway REST (v1) | **funcional** | REST API + recurso + integración MOCK + deployment/stage. Invocación `/execute-api/{id}/{stage}/health` y `{id}.execute-api.localhost.floci.io:4566` → 200. |
| API Gateway HTTP (v2) | **no probado** | Solo `create-api`. Según la documentación, de las integraciones `AWS_PROXY` solo se invoca `SQS-SendMessage`; `HTTP_PROXY` está soportado, pero no se ha verificado aquí. |
| API Gateway PRIVATE | **parcial** | Se acepta `types=PRIVATE` con `vpcEndpointIds`, pero la API responde 200 desde el host, fuera de la VPC. **No hay aislamiento de red.** |
| EC2 VPC / Subnets / Route tables | **solo metadatos** | Se crean y se describen; no hay enrutamiento real. Según la documentación, Floci crea una red Docker por VPC solo al lanzar instancias. |
| VPC Endpoints (Interface/Gateway) | **solo metadatos** | Estado `available`. El Interface tiene ENI y DNS `*.vpce.amazonaws.com` sintetizados; el Gateway (DynamoDB) **no añade rutas** de prefix list. |
| ECR | **funcional** | create-repository, login y `docker push`, `describe-images`. k3s descarga la imagen desde ECR. |
| EKS | **funcional (k3s)** | Clúster `ACTIVE`, kubeconfig con access key IAM, nodo `Ready`, Deployment + Service por DNS. No es EKS administrado. |
| IAM / STS | **parcial** | `create-role/user/access-key` y `get-caller-identity` funcionan. Según la documentación, Floci autentica pero no evalúa políticas (p. ej. `execute-api:Invoke`). |
| Terraform (provider + backend S3) | **funcional** | init/validate/plan/apply. Estado en `env:/<workspace>/` con versionado y `use_lockfile`; sin drift. |
| Persistencia (`persistent`) | **funcional** | S3, DynamoDB y Logs sobreviven a stop/start. |

Ver [`docs/limitations.md`](../../../docs/limitations.md) para el impacto en los requisitos de la especificación.

## Troubleshooting

| Síntoma | Causa / solución |
| --- | --- |
| `error getting credentials ... docker-credential-desktop: executable file not found` | `~/.docker/config.json` tiene `"credsStore": "desktop"` heredado de Docker Desktop. Los scripts lo detectan y usan un `DOCKER_CONFIG` aislado en `.tmp/`. Solución permanente (manual): quitar esa línea del archivo. |
| `start.sh`: puerto 4566 ocupado | Otro proceso (p. ej. LocalStack) usa el puerto: `ss -ltnp \| grep 4566`. |
| Healthy pero los datos desaparecen al reiniciar | `FLOCI_STORAGE_MODE` no llegó al contenedor. Revisar `scripts/floci/status.sh` (línea `Storage`) o `docker logs aegisvolt-floci \| grep 'Storage mode'`. |
| `kubectl`: `the server has asked for the client to provide credentials` | Se usó `test/test`. Usar una access key creada con `aws iam create-access-key`. |
| Pods en `ContainerCreating`/`ImagePullBackOff` justo tras crear el clúster | k3s aún inicializa CoreDNS/ServiceAccount, o no hay salida a Internet para descargar imágenes públicas. |
| Volúmenes `floci-aws-eks-*` huérfanos | En modo `persistent` `delete-cluster` no borra el volumen: `docker volume rm floci-aws-eks-<nombre>` tras confirmar que no está en uso. |
| `terraform init` falla con `NoSuchBucket` | El bucket de estado no existe; ejecutar `scripts/floci/terraform-check.sh`, que lo crea de forma idempotente. |
