# Runbook: Floci (emulador AWS local)

Operación diaria de Floci. La referencia completa (contenido del directorio, versiones verificadas y matriz de servicios) está en [infra/local/floci/README.md](../../infra/local/floci/README.md). Decisión: [ADR-0001](../adr/0001-floci-emulador-aws-local.md).

> **Regla del proyecto:** todo apunta a Floci en `localhost` con credenciales ficticias (`test`/`test`). Los scripts abortan si `AWS_ENDPOINT_URL` no es local o si la access key no es la ficticia (`scripts/floci/lib.sh#assert_local_endpoint`). Ningún script ejecuta `terraform destroy` ni borra `infra/local/floci/data/`.

## 1. Versión y contenedores

- **Imagen:** `floci/floci:2.4.0`, fijada por digest en `infra/local/floci/docker-compose.yml`.
- **Endpoint:** `http://localhost:4566`, publicado solo en `127.0.0.1`. HTTPS también responde en el mismo puerto (`FLOCI_TLS_ENABLED=true`), con la CA en `infra/local/floci/data/tls/floci-root-ca.crt`.
- **Región y cuenta:** `us-east-1` y `000000000000`.

| Contenedor | Lo crea | Para qué | Sigue vivo tras `stop.sh` |
| --- | --- | --- | --- |
| `aegisvolt-floci` | `start.sh` (docker compose) | El emulador | No |
| `floci-aws-ecr-registry` | Floci, al usar ECR | Registro de imágenes, `127.0.0.1:5100` | **Sí** |
| `floci-aws-eks-aegisvolt-<env>` | Floci, al crear un clúster EKS | k3s v1.36 de un nodo; API server en `0.0.0.0:65xx` (L-06) | **Sí** |
| `floci-aws-ui` | Floci, al abrir `/_floci/ui` | Consola web sin autenticación en `0.0.0.0:4500` (L-06). **Evítala** | **Sí** |

## 2. Uso diario

```bash
scripts/floci/start.sh                      # idempotente; espera a /_floci/health
scripts/floci/status.sh                     # contenedor, health, versión, modo de storage, contenedores hermanos
scripts/floci/smoke-test.sh                 # S3, DynamoDB, Logs, API Gateway, VPC/VPCE, ECR (recursos aegisvolt-smoke-<id>, se limpian)
scripts/floci/smoke-test.sh --with-eks      # + un clúster EKS temporal (~2 min)
scripts/floci/stop.sh                       # docker compose stop: conserva datos

set -a; source infra/local/floci/config/aws-local.env; set +a   # AWS CLI contra Floci en esta shell
aws dynamodb list-tables
curl -s http://localhost:4566/_floci/health | jq .version
```

`config/aws-local.env` también fija `AWS_CONFIG_FILE=/dev/null` y `AWS_SHARED_CREDENTIALS_FILE=/dev/null`: nunca se lee un perfil real de `~/.aws`.

## 3. Persistencia

- `FLOCI_STORAGE_MODE=persistent`: cada cambio se escribe en `infra/local/floci/data/` (ignorado por Git). S3, DynamoDB y Logs sobreviven a `stop.sh` y `start.sh`; esto está verificado.
- El contenedor corre con tu UID:GID, así que los archivos de `data/` son tuyos.
- **Reiniciar desde cero es destructivo:** se pierden el estado de Terraform, las tablas, los usuarios de Cognito y las imágenes. Ningún script lo hace. Solo con una decisión consciente: `scripts/floci/stop.sh` y luego mover `infra/local/floci/data/` a otro lugar. Después habría que repetir `terraform-bootstrap`, `terraform-global` y `terraform-live` de cada ambiente.

## 4. Apagar y encender el clúster de `dev`

El clúster k3s consume ~1,3 GB.

```bash
docker stop floci-aws-eks-aegisvolt-dev    # libera memoria; conserva el estado de Kubernetes
docker start floci-aws-eks-aegisvolt-dev   # vuelve a arrancar
```

Si al arrancar k3s termina con `failed to find interface with specified node ip`, el contenedor recibió otra IP. La recuperación, sin perder nada, está en [L-10](../limitations.md#l-10--el-clúster-k3s-de-floci-no-arranca-si-su-contenedor-cambia-de-ip).

## 5. Qué emula Floci y qué requeriría AWS real

Resumen para la sustentación. El detalle está en la [matriz de servicios](../../infra/local/floci/README.md#matriz-de-servicios) y en [limitations.md](../limitations.md).

| Capacidad | En Floci 2.4.0 | Lo que exigiría AWS real |
| --- | --- | --- |
| S3 con versionado, SSE AES256 y *lock* `use_lockfile` | **Funcional** | — |
| Política del bucket de estado | Se guarda, **no se evalúa** (L-12) | Evaluación real (`DenyInsecureTransport`, etc.) |
| SSE-KMS por defecto del bucket (probado y revertido; el bucket usa AES256) | No se aplica a los objetos (L-17, ADR-0036) | KMS real |
| DynamoDB (condiciones, transacciones, PITR, *deletion protection*) | **Funcional** | — |
| CloudWatch Logs, metric filters y alarmas de una métrica | **Funcional** | — |
| Logs Insights `stats`, EMF y *metric math* | **No** (L-09) | Funcionan; el diseño no depende de ellos |
| API Gateway REST → VPC Link → NLB → k3s | **Funcional** | — |
| API PRIVATE + `aws:SourceVpce` | Metadatos: responde desde fuera de la VPC (L-02) | Bloqueo real fuera del VPCE |
| VPC, subredes, rutas, NAT, SG y VPCE | **Solo metadatos** (L-01) | Enrutamiento y filtrado reales |
| EKS | k3s real de un nodo; endpoint privado no aplicado (L-03) | EKS administrado, node groups reales |
| NetworkPolicies | **Funcional** (kube-router de k3s) | VPC CNI *network policy agent* o Calico |
| IAM y Pod Identity | Autentica, **no evalúa** políticas (L-08); pods con credenciales ficticias por Secret | Credenciales temporales por rol |
| Cognito User Pools (JWT RS256, JWKS) | **Funcional**; creado con AWS CLI, no con Terraform (L-13) | — |
| ECR | **Funcional** (registry `registry:2`) | — |

## 6. Problemas frecuentes

| Síntoma | Qué hacer |
| --- | --- |
| `start.sh`: puerto 4566 ocupado | `ss -ltnp \| grep 4566`. Detén el otro proceso (por ejemplo, LocalStack) |
| Los datos desaparecen al reiniciar | `scripts/floci/status.sh`, línea `Storage`, debe decir `persistent` |
| `docker-credential-desktop: executable file not found` | Los scripts usan un `DOCKER_CONFIG` aislado. Para que no vuelva a pasar, quita `"credsStore": "desktop"` de `~/.docker/config.json` |
| `kubectl`: `provide credentials` | Usa la access key emitida por Floci: `source infra/local/floci/.tmp/k8s-<env>/kube-credentials.env` |
| `ImagePullBackOff` en el clúster | `docker start floci-aws-ecr-registry` y `aws ecr describe-images --repository-name aegisvolt/<app>` |
| Fluent Bit no envía logs | Floci debe correr con TLS (`config/floci.env`) y el log group tiene que existir (`terraform-live.sh <env> apply`) |
| Volúmenes `floci-aws-eks-*` huérfanos | `delete-cluster` no los borra. `docker volume rm` **solo** tras confirmar que no están en uso |
