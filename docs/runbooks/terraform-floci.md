# Runbook: Terraform contra Floci (bootstrap, workspaces, adopción y evidencias)

Diseño: [ADR-0033](../adr/0033-terraform-modular-backend-s3-floci.md). Código: [infra/terraform](../../infra/terraform/README.md). Limitaciones: L-01, L-02, L-03, L-08, L-11, L-12 y L-13 en [limitations.md](../limitations.md).

## Requisitos

- Floci en marcha: `scripts/floci/start.sh`.
- **Terraform 1.17.1** (`terraform version`).
- Nada más: los scripts cargan credenciales ficticias, no leen `~/.aws` y rechazan endpoints no locales.

## 1. Orden de ejecución

```bash
scripts/floci/terraform-bootstrap.sh apply        # 1. bucket del estado
scripts/floci/terraform-global.sh apply           # 2. ECR y ajuste de API Gateway
for env in dev test prod; do
  scripts/floci/terraform-live.sh "$env"          # 3. plan (fmt, init, workspace, validate)
  scripts/floci/terraform-live.sh "$env" apply    #    aplica ESE plan guardado
done
scripts/floci/k8s-deploy.sh dev                   # 4. aplicación en el clúster que creó Terraform
```

- Cada script rechaza un plan que destruya o reemplace recursos.
- `terraform-live.sh` acepta `--allow-destroy`, pero solo con autorización expresa.
- Ninguno ejecuta `destroy`.

## 2. Bootstrap y migración del estado local

`terraform-bootstrap.sh` contempla tres casos:

1. **Estado ya en S3:** init y plan/apply.
2. **Estado local existente:**
   - respaldo en `infra/local/floci/.tmp/tfstate-backups/`;
   - `terraform init -migrate-state -force-copy`;
   - comparación del contenido (recursos con atributos y outputs) por sha256;
   - el archivo local se renombra a `terraform.tfstate.migrated`.
3. **Sin bucket:**
   - apply con un `backend_override.tf` local temporal;
   - después, la migración del caso 2.

Ejecución real del 2026-11-15 (caso 2):

- 4 recursos, contenido idéntico: sha256 `c60cf91eeeacad56` antes y después.
- Terraform asignó un **lineage nuevo** al copiar el estado local al backend vacío (`73bc3c90…` → `ef182d95…`, serial 5 → 1). No se perdió información.
- Un primer intento del script abortó precisamente porque comparaba el lineage. Se cambió para comparar el contenido.

## 3. Adopción de lo que crearon los scripts de fases anteriores

```bash
scripts/floci/terraform-adopt.sh global   # 6 repositorios ECR (con sus imágenes)
scripts/floci/terraform-adopt.sh dev      # 5 tablas (con datos) + 3 ítems de flags
scripts/floci/terraform-adopt.sh test     # tabla de flags + 3 ítems
scripts/floci/terraform-adopt.sh prod     # tabla de flags + 3 ítems
```

- Es idempotente: solo importa lo que existe y no está en el estado.
- Después se revisó cada plan:
  - **`dev`:** 0 destrucciones. 28 recursos movidos (`module.observability` → `module.cloudwatch`). Cambios en sitio: etiquetas y el TTL de `aegisvolt-dispatch-dev`; los GSI sin cambios.
  - **`global`:** escaneo al subir y etiquetas en sitio; políticas de retención nuevas.
- **Los datos se conservaron:**
  - imágenes de ECR (4 en `graphql-api`);
  - ítems de las tablas (22 en `sagas`, 9 en `billing`…);
  - el valor actual de cada flag (`ENABLE_DYNAMIC_SURGE_PRICING` de `dev` en su versión 3; la semilla tiene `ignore_changes`).

**Problema encontrado.** `terraform import` guarda en el estado los data sources que lee, por ejemplo `module.cloudwatch.data.aws_region.current`. Eso ocupó la dirección de destino del bloque `moved` y el plan quiso destruir y recrear CloudWatch. El script lo rechazó.

- Se quitó ese data source del estado (no tiene objeto remoto) con `terraform state rm`.
- Desde entonces `terraform-adopt.sh` lo hace al terminar.

**Clúster EKS de `dev`** (autorizado):

- se borró el clúster del script (VPC por defecto) con `aws eks delete-cluster`, y su volumen k3s;
- Terraform lo recreó en la VPC de `dev`;
- `k8s-deploy.sh dev` redesplegó la aplicación y la prueba de humo pasó.

## 4. Evidencias (`scripts/floci/terraform-evidence.sh`)

El script escribe `infra/local/floci/.tmp/terraform-evidence.md`. Ejecución del 2026-11-15, con 19/19 comprobaciones correctas.

### Workspaces y claves que genera el backend

```text
$ terraform -chdir=infra/terraform/live workspace list
  default
* dev
  prod
  test

$ aws s3api list-objects-v2 --bucket aegisvolt-tfstate --query 'Contents[].[Key,Size]' --output text
bootstrap/terraform.tfstate             18951
env:/dev/aegisvolt/terraform.tfstate    306441
env:/prod/aegisvolt/terraform.tfstate   272165
env:/test/aegisvolt/terraform.tfstate   276275
global/terraform.tfstate                25672
```

Con `workspace_key_prefix = "env:"` y `key = "aegisvolt/terraform.tfstate"`, el backend escribe `env:/<workspace>/aegisvolt/terraform.tfstate`, y `<estado>.tflock` mientras está bloqueado.

### Estados separados y nombres sin colisión

| Workspace | Recursos gestionados | Lineage | Nombres de otro ambiente en el estado |
| --- | --- | --- | --- |
| dev | 57 (incluye EKS) | `3f19a410…` | ninguno |
| test | 49 | `645fd8c5…` | ninguno |
| prod | 49 | `5908a10a…` | ninguno |

| Recurso | dev | test | prod |
| --- | --- | --- | --- |
| Tablas | `aegisvolt-{reservations,billing,dispatch,sagas,feature-flags}-dev` | `…-test` | `…-prod` |
| VPC | 10.10.0.0/16 | 10.20.0.0/16 | 10.30.0.0/16 |
| APIs REST | `aegisvolt-dev-{public,private}` | `aegisvolt-test-…` | `aegisvolt-prod-…` |
| EKS | `aegisvolt-dev` | — (L-11) | — (L-11) |

Las tablas `aegisvolt-billing-demo-{dev,prod}` son restos de una demostración anterior. Terraform no las gestiona.

### Un apply en `test` no escribe los estados de `dev` ni de `prod`

Cambio inocuo en `test` (umbral de las alarmas 5 → 6, con `-var`), revertido después:

| Estado | Versión S3 antes | Versión S3 después |
| --- | --- | --- |
| dev | `e1569c54…` | `e1569c54…` (igual) |
| test | `81e06bc2…` | `f5aa4204…` (nueva) |
| prod | `685e8c8b…` | `685e8c8b…` (igual) |

CloudWatch tras el apply: `dev=5.0`, `test=6.0` y `prod=3.0`. Solo cambió `test`.

### Versionado y restauración del estado (§6.1)

```bash
aws s3api list-object-versions --bucket aegisvolt-tfstate --prefix 'env:/dev/aegisvolt/terraform.tfstate' \
  --query "Versions[?Key=='env:/dev/aegisvolt/terraform.tfstate'].[VersionId,LastModified,Size,IsLatest]" --output text
```

- El estado de `dev` tiene **15 versiones**: la primera, vacía, del 2026-11-15 01:04; la última, con EKS, de las 21:43.
- La anterior a la actual (`af8ed2e2…`, serial 14, mismo lineage) se descargó y `terraform show` la lee como estado válido.

**Restaurar una versión previa** ante un estado corrupto:

```bash
cd infra/terraform/live && terraform workspace select dev
terraform state pull > /tmp/actual.tfstate                         # 1. respaldo de lo actual
aws s3api get-object --bucket aegisvolt-tfstate --key 'env:/dev/aegisvolt/terraform.tfstate' \
  --version-id <id-previo> /tmp/previo.tfstate                     # 2. versión buena
terraform show /tmp/previo.tfstate >/dev/null                      # 3. legible
[ "$(jq -r .lineage /tmp/previo.tfstate)" = "$(jq -r .lineage /tmp/actual.tfstate)" ]  # 3b. mismo lineage
terraform state push -force /tmp/previo.tfstate                    # 4. -force: su serial es menor
scripts/floci/terraform-live.sh dev                                # 5. el plan muestra la deriva real
```

`state push` toma el lock del estado. `-force` omite las comprobaciones de serial y de lineage, que lo rechazarían por tener un serial menor; por eso el paso 3b comprueba antes el lineage. Copiar la versión como la más reciente con `aws s3api copy-object` también funciona, pero no toma el lock.

### Bloqueo nativo (`use_lockfile`)

- Dos `terraform plan` del workspace `test` en paralelo, cada uno con su propio `TF_DATA_DIR` y `-lock-timeout=0s`.
- Mientras el proceso A tenía el lock, existía `env:/test/aegisvolt/terraform.tfstate.tflock` con `{"Operation":"OperationTypePlan","Path":"aegisvolt-tfstate/env:/test/aegisvolt/terraform.tfstate",…}`.
- El proceso B falló:

```text
│ Error: Error acquiring the state lock
│ Error message: operation error S3: PutObject, https response error
│ StatusCode: 412 … api error PreconditionFailed: At least one of the pre-conditions you specified did not hold
```

- A terminó bien y el `.tflock` desapareció al liberarse.

### Guardas

| Intento | Resultado |
| --- | --- |
| `envs/prod.tfvars` en el workspace `test` | Rechazado por la precondición: "envs/prod.tfvars no corresponde al workspace test" |
| `-var floci_endpoint=https://dynamodb.us-east-1.amazonaws.com` | Rechazado por la validación de `floci_endpoint` |
| `-var 'allowed_account_ids=["123456789012"]'` | Rechazado por el provider (la cuenta de las credenciales es `000000000000`) |
| Workspace `default` | Rechazado por las validaciones de `environment` de los módulos |

## 5. Encender EKS en `test` o `prod` (L-11)

1. Asegúrate de tener memoria libre (cada k3s ocupa ~1,3 GB). Si hace falta, detén temporalmente el contenedor `floci-aws-eks-aegisvolt-dev`; al reiniciarlo, ver L-10.
2. Pon `eks.enabled = true` en `infra/terraform/live/envs/<env>.tfvars`.
3. Ejecuta `scripts/floci/terraform-live.sh <env>`: el plan agrega el clúster, el node group, el addon y 7 asociaciones.
4. Si el plan es el esperado, `scripts/floci/terraform-live.sh <env> apply`.

## 6. Cambios de red que recrean recursos

Al agregar un SG al NLB interno, Terraform debe recrearlo: AWS no permite asociar SG a un NLB creado sin ellos. Ocurrió lo mismo al retirar VPCE y al renombrar rutas (ADR-0034). Se aplicó por pasos:

1. **Revisar la lista exacta** de destrucciones: `terraform show -json <plan> | jq '.resource_changes[] | select(.change.actions | index("delete")) | .address'`. Solo se usa `--allow-destroy` si cada una tiene motivo.
2. **Renombres:** bloque `moved` en el módulo (`proxy["public"]` → `route["public-spa"]`). Si se aplica con `-target`, Terraform exige hacer antes el movimiento con `terraform state mv` (es equivalente; el bloque queda como no-op).
3. **Red primero:** `plan -target=module.network`, revisar y aplicar.
4. **NLB → VPC Link aparte:** `plan -target=…aws_api_gateway_vpc_link.this -target=…aws_lb_listener.ingress`. En el apply completo, el `create_before_destroy` del deployment de API Gateway se propaga a sus dependencias y produce:
   - un **ciclo** con la destrucción de los VPCE hermanos;
   - un **choque de nombre**: Terraform intenta crear el NLB nuevo `aegisvolt-<env>-ingress` antes de borrar el viejo.
5. **Resto:** `scripts/floci/terraform-live.sh <env> apply --allow-destroy` (solo deployments y la ruta privada antigua) y un último plan **sin cambios**.

## 7. Verificación de red, EKS y API Gateway

```bash
scripts/floci/network-verify.sh dev    # tabla requisito / implementación / evidencia / limitación
scripts/floci/network-verify.sh test
scripts/floci/network-verify.sh prod
```

- Informe: `infra/local/floci/.tmp/network-verify-<env>.md`.
- Cada fila dice si es **funcional** (Floci ejecuta el comportamiento) o **metadatos** (Floci solo guarda la configuración).
- La prueba de punta a punta (`POST /graphql` por HTTPS) requiere el clúster y el target del NLB, que registra `k8s-deploy.sh`. Hoy solo es posible en `dev` (L-11).

Prueba manual equivalente:

```bash
API=$(aws apigateway get-rest-apis --query "items[?name=='aegisvolt-dev-public'].id" --output text)
TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id "$COGNITO_CLIENT_ID" \
  --auth-parameters "USERNAME=operador,PASSWORD=$DEMO_PASSWORD" --query AuthenticationResult.IdToken --output text)
curl --cacert infra/local/floci/data/tls/floci-root-ca.crt "https://${API}.execute-api.localhost.floci.io:4566/dev/graphql" \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{"query":"{ viewer { fleetId } }"}'
terraform -chdir=infra/terraform/live output -raw kubeconfig > /tmp/kubeconfig   # exec aws eks get-token
```

## Problemas conocidos

- **Aviso `protocol_version` en `aws_lb_target_group.ingress`:** Floci devuelve el atributo en un target group TCP. Hoy es solo un aviso del provider.
- **Lineage nuevo tras migrar:** comportamiento de Terraform al copiar a un backend vacío (sección 2).
- **`terraform import` y data sources:** ver sección 3.
