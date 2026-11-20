# Guía de sustentación

Preparación de las preguntas del banco de [`proyecto_final.md`](../proyecto_final.md) §6. Cada respuesta tiene:

- **Respuesta en 30 segundos:** lo que se dice primero.
- **Demostración:** comandos en orden, qué mostrar en pantalla y el resultado esperado.
- **Archivos:** lo que hay que abrir si el profesor pide ver el código.
- **Floci frente a AWS real:** qué se ejecuta de verdad en el emulador, qué es solo configuración guardada y qué exigiría una cuenta AWS.
- **Repreguntas probables.**

Todo lo que se afirma aquí está implementado y fue verificado. La última auditoría completa es del 2026-11-19 y su evidencia está en `infra/local/floci/.tmp/audit-20261119/`; el resumen, en [requirements-traceability.md](requirements-traceability.md). Si algo **no** se verificó, la guía lo dice.

## Etiquetas

| Etiqueta | Significado |
| --- | --- |
| **[Floci · funcional]** | El emulador ejecuta el comportamiento: se puede demostrar en vivo |
| **[Floci · metadatos]** | Floci guarda la configuración y la devuelve al describirla, pero no la aplica |
| **[GitHub]** | Verificado en GitHub Actions, en un Floci temporal del runner |
| **[AWS real]** | Requeriría una cuenta AWS. **No se hizo**: las reglas del proyecto lo prohíben |

---

## 0. Preparación

### El día anterior

1. Encender todo y verificar (unos 10 minutos):

   ```bash
   cd ~/dev/aegisvolt && nvm use
   scripts/floci/start.sh
   docker start floci-aws-ecr-registry floci-aws-eks-aegisvolt-dev   # si estaban detenidos
   scripts/floci/status.sh
   scripts/floci/k8s-verify.sh dev            # debe terminar con todas las comprobaciones OK
   scripts/floci/network-verify.sh dev        # informe en infra/local/floci/.tmp/network-verify-dev.md
   ```

   Si k3s no arranca, aplica [L-10](limitations.md#l-10--el-clúster-k3s-de-floci-no-arranca-si-su-contenedor-cambia-de-ip).

2. Dejar abiertas en el navegador:
   - GitHub → **Settings → Rules → Rulesets** (`protect-dev`, `protect-test`, `protect-prod`);
   - GitHub → **Actions**, con la última ejecución de `deploy-floci` en `dev`, `test` y `prod`;
   - el PR #20 (`dev → test`) y el PR #21 (`test → prod`) con sus checks.
3. Ensayar la pregunta 6.3 **en `test`** (sección 6.3, opción A). Es la única que exige cambiar el estado local (encender el clúster de `test`), y conviene no hacerlo por primera vez en vivo.
4. Cerrar los `port-forward` que hayan dejado los scripts (L-20):

   ```bash
   ps -eo pid,args | awk '$2 ~ /kubectl$/ && /port-forward/ {print $1}' | xargs -r kill
   ```

### Al empezar la sustentación: variables de la terminal

Pega este bloque en una terminal que se use para todo:

```bash
cd ~/dev/aegisvolt
ENV=dev                                                   # ambiente que se demuestra
set -a
source infra/local/floci/config/aws-local.env             # AWS CLI → Floci, credenciales ficticias test/test
source infra/local/floci/.tmp/identity-$ENV.env           # COGNITO_CLIENT_ID, DEMO_PASSWORD, DEMO_FLEET (ficticios)
set +a
S=infra/local/floci/.tmp/k8s-$ENV
k() { (set -a; source "$S/kube-credentials.env"; set +a; KUBECONFIG="$S/kubeconfig" kubectl "$@"); }
k get nodes                                               # Ready
```

### Helpers de GraphQL (preguntas 6.3 y 6.4)

Los helpers abren `port-forward` a Traefik y a dos servicios internos, obtienen tokens de Cognito y crean datos de prueba. Son los mismos pasos del script con el que se hizo la demostración del 2026-11-19 (`audit-20261119/23-live-flag-saga.log`).

```bash
pf() { k -n "$1" port-forward "svc/$2" "$3:80" >/dev/null 2>&1 & }
pf traefik traefik 18090                                   # entrada del clúster: / → web, /graphql → graphql-api (canary)
pf aegisvolt station-reservation-service 18101             # solo para registrar una estación de prueba
pf aegisvolt billing-wallet-service 18102                  # solo para recargar la billetera de prueba
sleep 3; curl -fsS -o /dev/null http://127.0.0.1:18090/healthz && echo "Traefik OK"
G=http://127.0.0.1:18090/graphql

# Token de Cognito a través de la misma ruta que usa la consola (/auth/cognito → Floci por HTTPS):
token() { curl -fsS http://127.0.0.1:18090/auth/cognito -H 'content-type: application/x-amz-json-1.1' \
  -H 'x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth' \
  -d "{\"AuthFlow\":\"USER_PASSWORD_AUTH\",\"ClientId\":\"${COGNITO_CLIENT_ID}\",\"AuthParameters\":{\"USERNAME\":\"$1\",\"PASSWORD\":\"${DEMO_PASSWORD}\"}}" \
  | jq -r .AuthenticationResult.IdToken; }
gql() { curl -fsS "$G" -H 'content-type: application/json' -H "authorization: Bearer $1" ${3:+-H "x-correlation-id: $3"} -d "$2"; }
OP=$(token operador); AD=$(token admin)

# Valor y versión de la flag de falla en la tabla de cada ambiente (DynamoDB de Floci)
flag() { aws dynamodb get-item --table-name "aegisvolt-feature-flags-$1" \
  --key '{"PK":{"S":"FLAG#SIMULATE_CHARGER_HARDWARE_FAULT"},"SK":{"S":"META"}}' \
  --query 'Item.[enabled.BOOL,version.N]' --output text | tr '\t' '/'; }

# El administrador cambia la flag con la mutación GraphQL (sin redesplegar)
set_flag() { gql "$AD" "{\"query\":\"mutation { updateFeatureFlag(input:{key:\\\"SIMULATE_CHARGER_HARDWARE_FAULT\\\", enabled:$1}) { flag { key enabled version } } }\"}" \
  | jq -c '.data.updateFeatureFlag.flag // .errors'; }

# Estación nueva con 2 conectores y saldo para la flota de demostración.
# Se crea una por demostración: cada SAGA COMPLETED deja su conector OCCUPIED.
STATION="st_demo-$(date +%s)"
curl -fsS -o /dev/null -X PUT "http://127.0.0.1:18101/v1/stations/${STATION}" -H 'content-type: application/json' \
  -d '{"name":"Sustentación","city":"medellin","location":{"latitude":6.2,"longitude":-75.5},"connectors":[{"connectorId":"cn_01","type":"CCS2","maxPowerKw":60},{"connectorId":"cn_02","type":"CCS2","maxPowerKw":60}]}'
curl -fsS -o /dev/null -X PUT "http://127.0.0.1:18102/v1/wallets/${DEMO_FLEET}/top-ups/tup_demo-$(date +%s)" \
  -H 'content-type: application/json' -d '{"amount":{"amountMinor":50000000,"currency":"COP"}}'

# Dispara la mutación de la SAGA con un correlation_id elegido por nosotros
reserve() {
  local c; c=$(gql "$OP" "{\"query\":\"{ availableConnectors(stationId: \\\"${STATION}\\\") { connector { connectorId } } }\"}" \
    | jq -r '.data.availableConnectors[0].connector.connectorId')
  gql "$OP" "{\"query\":\"mutation { reserveAndActivateCharging(input:{idempotencyKey:\\\"$(cat /proc/sys/kernel/random/uuid)\\\", stationId:\\\"${STATION}\\\", connectorId:\\\"${c}\\\", requestedEnergyKwh: 10}) { saga { status sagaId } } }\"}" "$1" \
    | jq -c '.data.reserveAndActivateCharging.saga // .errors'; }
```

Los `PUT` a station-reservation y a billing-wallet preparan datos. No forman parte de la SAGA: la SAGA se dispara **solo** con la mutación GraphQL.

---

## 6.1 Infraestructura como código, S3 y redes (30 %)

### 6.1.1 "¿Cómo garantiza su código de Terraform que al ejecutar `terraform apply` en la rama `test` no se sobrescriban las tablas de DynamoDB ni el estado del ambiente `prod` en S3?"

**Respuesta en 30 segundos.** Hay cinco barreras independientes:

1. **Un estado por workspace.** El backend S3 guarda cada workspace en su propia clave: `env:/test/aegisvolt/terraform.tfstate` y `env:/prod/aegisvolt/terraform.tfstate`. Un `apply` en `test` solo lee, bloquea y escribe el estado de `test`.
2. **Nombres derivados del workspace.** `local.environment = terraform.workspace`, y cada tabla se llama `aegisvolt-<dominio>-${terraform.workspace}`. El estado de `test` no contiene ningún recurso de `prod`, así que Terraform no puede modificarlo ni borrarlo.
3. **Precondición.** El plan falla si el workspace no es `dev`, `test` o `prod`, o si el `tfvars` no corresponde al workspace (por ejemplo `envs/prod.tfvars` en `test`).
4. **El pipeline elige el workspace por la rama**, no por un parámetro. Los scripts verifican el workspace seleccionado y rechazan cualquier plan que destruya o reemplace recursos.
5. **En `prod`, las tablas tienen `deletion_protection = true`.** El bloqueo de estado (`use_lockfile`) es por estado: un `apply` en `test` no bloquea a `prod`.

**Demostración**

```bash
# 1. Workspaces y claves separadas en el bucket versionado [Floci · funcional]
terraform -chdir=infra/terraform/live workspace list
aws s3api list-objects-v2 --bucket aegisvolt-tfstate --query 'Contents[].[Key,Size]' --output table
#   env:/dev/aegisvolt/terraform.tfstate · env:/test/... · env:/prod/... · bootstrap/... · global/...

# 2. El estado de test solo contiene nombres de test
aws s3 cp s3://aegisvolt-tfstate/env:/test/aegisvolt/terraform.tfstate - \
  | jq -r '.resources[] | select(.type=="aws_dynamodb_table") | .instances[].attributes.name'
#   aegisvolt-billing-test, aegisvolt-dispatch-test, aegisvolt-feature-flags-test, ...

# 3. La guarda: tfvars de prod en el workspace test → el plan falla
TF_WORKSPACE=test terraform -chdir=infra/terraform/live plan -input=false -refresh=false -no-color \
  -var-file=config/floci/target.tfvars -var-file=envs/prod.tfvars 2>&1 | grep -A1 "precondition failed"
#   Error: Resource precondition failed
#   envs/prod.tfvars no corresponde al workspace test.      (verificado el 2026-11-19)

# 4. Plan normal de test: workspace verificado, sin cambios en prod
scripts/floci/terraform-live.sh test          # fmt, init, workspace select test, validate, plan (no aplica)
```

**Evidencia ya registrada** ([terraform.md §4](runbooks/terraform.md#un-apply-en-test-no-escribe-los-estados-de-dev-ni-de-prod)): `scripts/floci/terraform-evidence.sh` aplicó un cambio inocuo en `test` (umbral de alarma 5 → 6) y comparó la versión S3 de cada estado.

| Estado | Versión S3 antes | Versión S3 después |
| --- | --- | --- |
| dev | `e1569c54…` | `e1569c54…` (igual) |
| test | `81e06bc2…` | `f5aa4204…` (nueva) |
| prod | `685e8c8b…` | `685e8c8b…` (igual) |

Si piden repetirlo en vivo: `scripts/floci/terraform-evidence.sh`. Tarda ~4,5 min; hace ese `apply` en `test` y lo revierte. No toca `dev` ni `prod`.

**Archivos**

| Qué | Dónde |
| --- | --- |
| Backend con `workspace_key_prefix = "env:"` y `use_lockfile` | [`infra/terraform/live/config/floci/backend.hcl`](../infra/terraform/live/config/floci/backend.hcl) |
| `environment = terraform.workspace` | [`infra/terraform/live/main.tf`](../infra/terraform/live/main.tf), línea 6 |
| Nombres de tablas `aegisvolt-${each.key}-${local.environment}` | `infra/terraform/live/main.tf`, línea 52 |
| Precondiciones `workspace_guard` | `infra/terraform/live/main.tf`, líneas 34–43 |
| `deletion_protection = true` en prod | [`infra/terraform/live/envs/prod.tfvars`](../infra/terraform/live/envs/prod.tfvars), línea 18 |
| Selección y verificación del workspace | [`scripts/floci/terraform-live.sh`](../scripts/floci/terraform-live.sh), líneas 28–29; [`scripts/ci/floci-environment.sh`](../scripts/ci/floci-environment.sh), líneas 35–37 |

**Floci frente a AWS real.** Workspaces, claves por workspace, versionado y bloqueo con `.tflock` son **[Floci · funcional]**: el lock se probó con dos `plan` en paralelo y el segundo recibió 412. La política del bucket se guarda pero Floci no la evalúa (L-12). En **[AWS real]** el rol `aegisvolt-terraform-admin` y esa política limitarían además quién puede escribir el bucket.

**Repreguntas probables**

- *¿Y si alguien ejecuta `terraform apply` a mano en el workspace equivocado?* La precondición exige que el `tfvars` coincida con el workspace. Si además usa el `tfvars` correcto de otro ambiente, está operando ese ambiente de forma explícita. Por eso el pipeline no recibe el ambiente como parámetro: lo deriva de la rama.
- *¿Por qué workspaces y no directorios por ambiente?* La especificación los exige (§2.4). Además garantizan una sola definición de módulos para los tres ambientes; las diferencias viven solo en `envs/<env>.tfvars` ([ADR-0011](adr/0011-terraform-workspaces-backend-s3-bootstrap.md)).

### 6.1.2 "Muestre en su bucket S3 las versiones anteriores del archivo `terraform.tfstate` del workspace `dev` y explique cómo restauraría la versión previa ante un cambio corrupto."

**Respuesta en 30 segundos.** El bucket `aegisvolt-tfstate` tiene el versionado en `Enabled`, declarado en Terraform (`infra/terraform/bootstrap`). Cada `apply` crea una versión nueva de `env:/dev/aegisvolt/terraform.tfstate`. Para restaurar:

1. respaldo el estado actual;
2. descargo la versión buena por `VersionId`;
3. compruebo que es legible y que tiene el mismo *lineage*;
4. la subo con `terraform state push -force`, que toma el lock;
5. ejecuto `plan` para ver la diferencia entre ese estado y la infraestructura real.

**Demostración** [Floci · funcional]

```bash
# 1. Versionado activo
aws s3api get-bucket-versioning --bucket aegisvolt-tfstate            # "Status": "Enabled"

# 2. Versiones del estado de dev (la más reciente con IsLatest=True)
aws s3api list-object-versions --bucket aegisvolt-tfstate --prefix 'env:/dev/aegisvolt/terraform.tfstate' \
  --query "Versions[?Key=='env:/dev/aegisvolt/terraform.tfstate'].[VersionId,LastModified,Size,IsLatest]" --output table

# 3. Descargar la versión anterior y leerla (sin restaurarla todavía)
PREV=$(aws s3api list-object-versions --bucket aegisvolt-tfstate --prefix 'env:/dev/aegisvolt/terraform.tfstate' \
  --query "Versions[?Key=='env:/dev/aegisvolt/terraform.tfstate'] | [1].VersionId" --output text)
aws s3api get-object --bucket aegisvolt-tfstate --key 'env:/dev/aegisvolt/terraform.tfstate' --version-id "$PREV" /tmp/previo.tfstate
jq '{serial, lineage, recursos: (.resources | length)}' /tmp/previo.tfstate
```

**Procedimiento de restauración.** Explícalo; ejecútalo solo si lo piden ([terraform.md §4](runbooks/terraform.md#versionado-y-restauración-del-estado-61)):

```bash
cd infra/terraform/live && terraform workspace select dev
terraform state pull > /tmp/actual.tfstate                                    # 1. respaldo de lo actual
terraform show /tmp/previo.tfstate >/dev/null                                 # 2. la versión buena es legible
[ "$(jq -r .lineage /tmp/previo.tfstate)" = "$(jq -r .lineage /tmp/actual.tfstate)" ] && echo "mismo lineage"
terraform state push -force /tmp/previo.tfstate                               # 3. -force: su serial es menor
cd - && scripts/floci/terraform-live.sh dev                                   # 4. el plan muestra la deriva
```

- **Por qué `-force`:** Terraform rechaza subir un estado con un *serial* menor. `-force` omite esa comprobación y la del *lineage*; por eso el *lineage* se compara antes, a mano.
- **Por qué `state push` y no `aws s3api copy-object`:** `state push` toma el lock del estado; copiar el objeto no lo toma.
- **Qué hacer después:** el `plan` dice qué recursos existen en la realidad y no en el estado restaurado. Se corrige con `import` o con un `apply` revisado, nunca a ciegas.
- **Evidencia ya registrada:** el estado de `dev` tenía 15 versiones el 2026-11-15. La anterior a la actual (serial 14, mismo *lineage*) se descargó y `terraform show` la leyó como un estado válido.

**Archivos:** [`infra/terraform/bootstrap/main.tf`](../infra/terraform/bootstrap/main.tf) (versionado, línea 23; SSE AES256; bloqueo de acceso público; ciclo de vida).

**Floci frente a AWS real.** El versionado y `--version-id` son **[Floci · funcional]**. En **[AWS real]** se evaluaría además la política `ProtectBucketAndHistory`, que impide borrar versiones (L-12). El cifrado con SSE-KMS se probó y se revirtió porque Floci no lo aplica a los objetos ([ADR-0036](adr/0036-riesgos-trivy-aceptados-y-reversion-kms.md), L-17). El bucket usa AES256.

**Repreguntas probables**

- *¿Y si se corrompe el bucket entero?* El ciclo de vida conserva las versiones no actuales (`infra/terraform/bootstrap/main.tf`). El bucket de estado no lo gestiona el mismo estado que guarda: lo crea `bootstrap`, que tiene su propia clave.
- *¿Por qué no hay tabla DynamoDB de lock?* `dynamodb_table` está deprecado desde Terraform 1.11. `use_lockfile` usa una escritura condicional en S3 (`If-None-Match`), verificada en Floci ([ADR-0033](adr/0033-terraform-modular-backend-s3-floci.md)).

### 6.1.3 "Explique el recorrido de un paquete de red desde el API Gateway hasta el pod en Kubernetes a través del VPC Endpoint (VPCE) y qué tabla de enrutamiento o política de seguridad interviene."

**Respuesta en 30 segundos.** Primero la precisión técnica: un VPC Endpoint **no** lleva tráfico desde API Gateway hacia un pod. Un VPCE es una *salida* de la VPC hacia un servicio de AWS. El camino de *entrada* es **API Gateway → VPC Link → NLB interno → Traefik → pod** ([ADR-0010](adr/0010-red-apigw-vpc-link-nlb-y-vpce.md)). El VPCE `execute-api` sirve para lo inverso: que un cliente *dentro* de la VPC llame a la API **PRIVATE** sin salir a Internet.

**Recorrido de `POST /graphql`** ([04-networking.md](architecture/04-networking.md#recorrido-de-un-paquete-pregunta-61)):

| # | Salto | Qué interviene | En Floci |
| --- | --- | --- | --- |
| 1 | Cliente → API Gateway REST REGIONAL por HTTPS | *Throttling* del stage. El JWT de Cognito lo valida graphql-api (L-13) | [Floci · funcional], TLS con la CA local |
| 2 | API Gateway → VPC Link | Integración `HTTP_PROXY` con `connection_type = VPC_LINK` | [Floci · funcional] |
| 3 | VPC Link → NLB interno (subredes privadas) | **SG del NLB: sin reglas de entrada**; solo se entra por el VPC Link (PrivateLink sin evaluar SG). Egreso solo al puerto del ingress hacia las subredes privadas | NLB funcional; SG [Floci · metadatos] |
| 4 | NLB → target `ip` del ingress | **SG del clúster EKS: entrada al puerto del ingress solo desde el SG del NLB.** Target group con health check HTTP | Target `healthy` [Floci · funcional]; SG [metadatos] |
| 5 | Traefik → Service `graphql-api` → pod | `IngressRoute` y `TraefikService` con pesos (canary); **NetworkPolicies** `default-deny-all` más permisos explícitos | [Floci · funcional] (kube-router) |
| 6 | Pod → orquestador y servicios | `ClusterIP` y NetworkPolicies por par de servicios | [Floci · funcional] |
| 7 | Servicios → DynamoDB | **Tabla de rutas privada:** ruta de *prefix list* `pl-… (DynamoDB) → Gateway VPCE`, con *endpoint policy* limitada a las tablas del ambiente | [Floci · metadatos]: Floci no añade la ruta (L-01) |
| 8 | Fluent Bit → CloudWatch Logs | Interface VPCE `logs`, *private DNS*, SG 443 desde las subredes privadas | [Floci · metadatos] |
| — | Salida a Internet (JWKS de Cognito) | Tabla de rutas privada: `0.0.0.0/0 → NAT Gateway` | [Floci · metadatos] |

**Demostración**

```bash
# 1. La cadena funciona de punta a punta, por HTTPS [Floci · funcional]
scripts/floci/network-verify.sh dev
less infra/local/floci/.tmp/network-verify-dev.md          # cada fila marcada como funcional o metadatos

# 2. API Gateway → VPC Link → NLB
API=$(aws apigateway get-rest-apis --query "items[?name=='aegisvolt-dev-public'].id" --output text)
aws apigateway get-vpc-links --query 'items[].[name,status,targetArns[0]]' --output table
RID=$(aws apigateway get-resources --rest-api-id "$API" --query "items[?path=='/graphql'].id" --output text)
aws apigateway get-integration --rest-api-id "$API" --resource-id "$RID" --http-method POST \
  --query '{type:type,connection:connectionType,vpcLink:connectionId,uri:uri}'
#   HTTP_PROXY · VPC_LINK · uri http://floci:18081/graphql (en AWS: el DNS del NLB interno)

# 3. Target del NLB sano (las salidas de Terraform son las del workspace seleccionado)
terraform -chdir=infra/terraform/live workspace select dev
TG=$(terraform -chdir=infra/terraform/live output -raw api_target_group_arn)
aws elbv2 describe-target-health --target-group-arn "$TG" --query 'TargetHealthDescriptions[].[Target.Id,Target.Port,TargetHealth.State]'
#   <IP del contenedor k3s>  30080  healthy

# 4. Security groups (configuración declarada) [Floci · metadatos]
NLB_SG=$(terraform -chdir=infra/terraform/live output -raw nlb_security_group_id)
CL_SG=$(terraform -chdir=infra/terraform/live output -raw eks_cluster_security_group_id)
aws ec2 describe-security-groups --group-ids "$NLB_SG" --query 'SecurityGroups[0].{in:IpPermissions,out:IpPermissionsEgress[].[FromPort,IpRanges[].CidrIp]}'
#   in: []  ·  out: 30080 → 10.10.16.0/20 y 10.10.32.0/20 (subredes privadas)
aws ec2 describe-security-groups --group-ids "$CL_SG"  --query 'SecurityGroups[0].IpPermissions[].{port:FromPort,desde:UserIdGroupPairs[].GroupId}'
#   30080 desde el SG del NLB (+ la regla del propio SG del clúster, que gestiona EKS)

# 5. Tablas de rutas privadas y VPCE [Floci · metadatos]
VPC=$(terraform -chdir=infra/terraform/live output -raw vpc_id)
aws ec2 describe-route-tables --filters Name=vpc-id,Values="$VPC" --query 'RouteTables[].{tabla:Tags[?Key==`Name`]|[0].Value,rutas:Routes[].[DestinationCidrBlock,NatGatewayId,GatewayId,DestinationPrefixListId]}'
#   pública: 0.0.0.0/0 → igw · privadas: 0.0.0.0/0 → nat · SIN la ruta pl-* del Gateway VPCE (Floci no la añade, L-01)
aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values="$VPC" --query 'VpcEndpoints[].[ServiceName,VpcEndpointType,State]' --output table
#   6 Interface (logs, monitoring, ecr.api, ecr.dkr, execute-api, eks-auth) + 2 Gateway (s3, dynamodb), todos available

# 6. NetworkPolicies, que sí se aplican [Floci · funcional]
k -n aegisvolt get networkpolicy
grep "Red:" "$S/verify.md"                                 # p. ej. billing → station: bloqueado (default-deny)
```

**Qué decir sobre Floci, con transparencia.**

- La cadena API Gateway → VPC Link → NLB → k3s → Traefik → pod **responde de verdad**.
- Lo que no es real: el NLB vive en el contenedor de Floci y apunta a `http://floci:<puerto>` porque el DNS `*.elb.floci` no resuelve (L-01). El target es la IP del contenedor k3s más el NodePort 30080 de Traefik; en AWS sería el puerto 8000 de los pods de Traefik.
- Las tablas de rutas, los SG y los VPCE existen con la configuración correcta, pero Floci **no enruta ni filtra** con ellos (L-01, L-14). La ruta de *prefix list* del Gateway VPCE ni siquiera aparece.
- La API PRIVATE responde 200 desde fuera de la VPC (L-02).
- El aislamiento que sí se demuestra en local lo dan las **NetworkPolicies**.
- Probar el filtrado real de SG, rutas y VPCE exigiría **[AWS real]**.

**Archivos:** [`infra/terraform/modules/network/main.tf`](../infra/terraform/modules/network/main.tf) (VPC, subredes, rutas, VPCE y sus políticas), [`infra/terraform/modules/api-gateway/main.tf`](../infra/terraform/modules/api-gateway/main.tf) (API REGIONAL y PRIVATE, VPC Link, NLB y SG del NLB), [`infra/terraform/modules/eks/main.tf`](../infra/terraform/modules/eks/main.tf), líneas 142–152 (entrada desde el SG del NLB), y las NetworkPolicies en `infra/k8s/base`.

**Repreguntas probables**

- *¿Entonces dónde está el "VPCE hacia API Gateway" que pide §2.4?* Es el Interface VPCE `execute-api`, asociado a la API **PRIVATE**, cuya *resource policy* solo permite `aws:SourceVpce = <ese VPCE>`. Lo usan los consumidores internos, como Prefect. ¿Y "hacia Kubernetes"? Es el endpoint privado del API server de EKS (`endpointPrivateAccess = true`, `endpointPublicAccess = false`). AWS aclara que no es un endpoint PrivateLink tradicional; en Floci, solo metadatos (L-03).
- *¿Por qué NLB y no ALB?* Un VPC Link de una API REST (V1) solo apunta a un NLB. El enrutamiento L7 lo hace Traefik.

---

## 6.2 CI/CD, promoción de ambientes y canary (25 %)

### 6.2.1 "Intente hacer un `git push --force` o un push directo a la rama `test` desde su terminal y muestre qué regla del repositorio lo bloquea."

**Respuesta en 30 segundos.** El ruleset `protect-test` está activo, con la lista de *bypass* vacía. Ni siquiera el propietario del repositorio puede saltárselo. Tiene cuatro reglas:

- **Block force pushes** (`non_fast_forward`);
- **Require a pull request before merging**, solo con merge commit;
- **Restrict deletions**;
- **Require status checks to pass**, con 20 checks, incluidos `unit-tests`, `integration-tests`, `e2e-tests` y `terraform-plan`. Las tres ramas exigen `terraform-plan`; en `dev` se retiró temporalmente para fusionar el PR #18 y ya se volvió a agregar (verificado con la API de GitHub).

Además, `promotion-guard` rechaza cualquier PR hacia `test` que no venga de `dev`.

**Demostración** [GitHub]

Primero, la configuración (no cambia nada):

```bash
gh api repos/{owner}/{repo}/rules/branches/test --jq '.[] | .type'
#   deletion · non_fast_forward · pull_request · required_status_checks
gh api repos/{owner}/{repo}/rulesets --jq '.[] | [.name, .enforcement] | @tsv'
```

Después, los intentos. Usa un commit **vacío** para que, aunque una regla fallara, no cambie ningún archivo. Anota antes el SHA actual de `test`:

```bash
git fetch origin
ORIG_TEST=$(git rev-parse origin/test); echo "test = $ORIG_TEST"

# a) Push directo (fast-forward) a test
git switch -c demo/push-directo origin/test
git commit --allow-empty -m "demo: push directo (debe ser rechazado)"
git push origin HEAD:test
#   esperado: remote: error: GH013: Repository rule violations found for refs/heads/test
#             - Changes must be made through a pull request.

# b) Force push (reescribe historia) a test
git switch -c demo/force origin/test~1
git commit --allow-empty -m "demo: force push (debe ser rechazado)"
git push --force origin HEAD:test
#   esperado: GH013 … - Cannot force-push to this branch (y la regla de PR)

# Limpieza local: nada llegó al remoto
git switch dev && git branch -D demo/push-directo demo/force
git fetch origin && [ "$(git rev-parse origin/test)" = "$ORIG_TEST" ] && echo "test intacto"
```

> **Honestidad.** Este rechazo **todavía no se ha capturado** en una ejecución real (auditoría, hallazgo 2). Los textos son los que documenta GitHub para `GH013`. **Ensáyalo antes de la sustentación** y guarda la salida. Las reglas están verificadas por la API (`audit-20261119/github-rules.txt`). Si por algún motivo el push se aceptara, el remoto tendría un commit vacío: se revierte con un PR, sin force push.

Prueba adicional de la cadena de promoción, sin riesgo:

```bash
gh pr create --base test --head <una-rama-feature> --title "debe fallar" --body "prueba"
gh pr checks --watch     # promotion-guard: "test solo recibe PRs desde dev"; cierra el PR sin fusionar
```

**Archivos:** [`docs/runbooks/github-repository-settings.md`](runbooks/github-repository-settings.md) §2, [`scripts/ci/promotion-guard.sh`](../scripts/ci/promotion-guard.sh) y su prueba `scripts/ci/promotion-guard.test.sh`, y el job `promotion-guard` en [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

**Historial que respalda la promoción lineal.** Los PR fusionados son: `feature/* → dev` (#1–#18), `dev → test` (#15, #20) y `test → prod` (#21). Ninguna rama `feature/*` llegó a `test` o `prod`.

**Repreguntas probables**

- *¿Por qué squash en `dev` y merge commit en `test` y `prod`?* Si una promoción se hace con squash, `test` recibe un commit distinto a los de `dev`. Las ramas divergen y cada promoción siguiente genera conflictos. Con merge commit, `test` contiene exactamente los commits de `dev`.
- *¿Hay aprobaciones obligatorias?* Cero: el proyecto es individual y GitHub no deja que el autor apruebe su propio PR. Exigir una aprobación bloquearía todos los merges.

### 6.2.2 "Explique en el archivo YAML de su pipeline cómo se determina dinámicamente sobre qué ambiente correr `terraform apply` tras fusionar un Merge Request."

**Respuesta en 30 segundos.** El ambiente sale de la rama que recibió el merge.

1. `deploy-floci.yml` solo se dispara con `push` a `dev`, `test` o `prod`, que es el evento que produce un merge.
2. El job `resolve-environment` ejecuta `scripts/ci/resolve-environment.sh`, que lee `GITHUB_REF_NAME` y solo acepta esos tres valores. Cualquier otra rama falla antes de tocar un environment.
3. Su salida `environment` alimenta tres cosas del job `deploy`:
   - el `environment:` de GitHub, con sus reglas;
   - el grupo de `concurrency`;
   - la variable `ENVIRONMENT`.
4. El script vuelve a comprobar que coincide con la rama.
5. `floci-environment.sh` regenera el plan del workspace con `terraform-live.sh $ENV plan`, ejecuta `terraform workspace select $ENV`, verifica `workspace show == $ENV` y aplica **ese** plan guardado.

En los PR, `terraform-plan.yml` usa el mismo script, que con `pull_request` lee la rama **destino** (`GITHUB_BASE_REF`).

**Recorrido del YAML** ([`.github/workflows/deploy-floci.yml`](../.github/workflows/deploy-floci.yml)):

| Línea | Qué mostrar |
| --- | --- |
| 19–21 | `on: push: branches: [dev, test, prod]` |
| 27–41 | Job `resolve` → `run: scripts/ci/resolve-environment.sh` y `outputs.environment` |
| 52–58 | `environment: name: ${{ needs.resolve.outputs.environment }}`, `concurrency` por ambiente, `ENVIRONMENT` |
| 64–67 | "Workspace = rama integrada": vuelve a validar con `EXPECTED_ENVIRONMENT` |
| 82–83 | `scripts/ci/floci-environment.sh "$ENVIRONMENT"` |
| 113–123 | Job `canary`: `canary-deployment.yml` con el mismo ambiente y la línea base `github.event.before` |

Luego abre [`scripts/ci/resolve-environment.sh`](../scripts/ci/resolve-environment.sh) (el `case` por evento y la lista cerrada) y [`scripts/ci/floci-environment.sh`](../scripts/ci/floci-environment.sh), líneas 22–37 (plan, resumen, `workspace select`, verificación y `apply` del plan).

**Demostración** [GitHub]: en **Actions → deploy-floci**, abre la ejecución de `test` (commit `9626f5e`). El resumen del job muestra:

- "Ambiente: test";
- "Terraform apply · workspace `test`";
- el plan aplicado y los informes de red y Kubernetes.

En local, sin GitHub:

```bash
GITHUB_EVENT_NAME=push GITHUB_REF_NAME=test scripts/ci/resolve-environment.sh         # Ambiente: test
GITHUB_EVENT_NAME=push GITHUB_REF_NAME=feature/x scripts/ci/resolve-environment.sh    # error: no es dev, test ni prod
GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF=prod scripts/ci/resolve-environment.sh # Ambiente: prod
```

**Diferencia con la especificación.** §3.3 dice `terraform apply -auto-approve`. El pipeline aplica un **plan guardado**, que tampoco pide confirmación. La diferencia es que lo aplicado es exactamente lo que se revisó y se publicó en el resumen, y que antes se rechazan las destrucciones.

**Floci frente a AWS real (L-15, [ADR-0035](adr/0035-cicd-github-actions-runners-hospedados-floci-efimero.md)).** El `apply` ocurre en un **Floci temporal** dentro del runner hospedado. El repositorio es público y el Floci persistente del autor no se expone a Internet, así que GitHub no puede alcanzarlo. Cada despliegue crea, verifica y destruye su propio ambiente. En **[AWS real]** el mismo workflow necesitaría credenciales por OIDC y un estado persistente; no está implementado.

### 6.2.3 "¿Qué métrica o condición evalúa su etapa de Canary Deployment antes de promover el tráfico del 20 % al 100 % en Kubernetes?"

**Respuesta en 30 segundos.** El canary de graphql-api lo ejecuta **Argo Rollouts**. El reparto por peso lo hace **Traefik**, con estos pasos:

1. 20 %;
2. análisis;
3. 50 %;
4. análisis;
5. 100 %.

Cada análisis (`AnalysisTemplate graphql-api-canary-health`) mide dos cosas:

- **Disponibilidad:** `GET /health/ready` del Service del canary cada 10 s, 12 veces. Aprueba si responde `ready` en al menos 11 de 12.
- **Tasa de error leída de CloudWatch:** dos series por versión, `GraphqlOperations` y `GraphqlServerErrors` (namespace `AegisVolt/<env>`, dimensión `Version`). Se empieza a medir tras 60 s, cada 30 s, 4 veces, sobre una ventana de 3 min. Aprueba si hay **al menos 30 operaciones** del canary y `errores / operaciones ≤ 2 %`.

Dos mediciones fallidas abortan el Rollout y devuelven el 100 % del tráfico a la versión estable. Con menos de 30 operaciones la medición es *Inconclusive* y el Rollout se **pausa**: no se promueve una versión sin evidencia.

**Demostración** [Floci · funcional]

```bash
# Definición
sed -n '1,80p' infra/k8s/components/canary/analysis-template.yaml
grep -n -A3 "setWeight\|analysis:" infra/k8s/components/canary/rollout.yaml

# Promoción en vivo (~6 min): imagen nueva → 20 % → análisis → 50 % → análisis → 100 %
scripts/floci/canary-demo.sh dev success
# Rollback inducido (~4 min): versión mal configurada → error-rate Failed → abort → 100 % estable
scripts/floci/canary-demo.sh dev failure
# Informe: tráfico medido por tramo de peso y mediciones de cada AnalysisRun
cat "$(ls -td infra/local/floci/.tmp/k8s-dev/canary-*/ | head -1)report.md"    # el más reciente

# Mientras corre, en otra terminal:
k -n aegisvolt get rollout graphql-api -o jsonpath='{.status.phase} paso={.status.currentStepIndex}{"\n"}'
k -n aegisvolt get traefikservice graphql-api-split -o jsonpath='{.spec.weighted.services}{"\n"}'
k -n aegisvolt get analysisrun
```

**Resultados ya registrados.** Porcentajes medidos en las respuestas por la cabecera `x-service-version`, no deducidos del número de pods:

| Ejecución | 80/20 | 50/50 | Desenlace |
| --- | --- | --- | --- |
| Local, 2026-11-19 (`audit-20261119/27-canary-success-report.md`) | 78,1 / 21,9 % | 49,2 / 50,8 % | Promovido |
| GitHub, merge a `dev`, 2026-11-16 | 79,2 / 20,8 % | 47,7 / 52,3 % | Promovido |
| Local, rollback inducido, 2026-11-19 (`28-canary-failure-report.md`) | — | — | Abortado: `Metric "error-rate" assessed Failed due to failed (2) > failureLimit (1)`; pesos de vuelta a 100/0 |

**Floci frente a AWS real.**

- Argo lee CloudWatch de Floci con su proveedor nativo. Las métricas salen de logs reales → Fluent Bit → *metric filters* de Terraform: **[Floci · funcional]**.
- La tasa se calcula en la condición del análisis porque Floci no tiene *metric math* (L-04).
- **[AWS real]** quedarían por validar las credenciales del controlador por Pod Identity y la latencia real de los *metric filters*, que justifica el `initialDelay` de 60 s.
- Alcance: solo graphql-api, el tráfico norte-sur. Hacer canary de los servicios internos exigiría una malla de servicios ([ADR-0032](adr/0032-canary-argo-rollouts-traefik-cloudwatch.md)).
- En el pipeline, `prod` declaró "canary no ejecutado": su línea base fue el primer despliegue con canary y no había versión estable con Argo (hallazgo 5).

---

## 6.3 Patrones arquitectónicos, SAGA y feature flags (25 %)

### 6.3.1 "Active la Feature Flag de fallo en el ambiente `test`, dispare una mutación GraphQL de reserva de carga y demuestre en las tablas de DynamoDB cómo se ejecutó la transacción compensatoria en el servicio de facturación y reservas."

**Respuesta en 30 segundos.** La SAGA es **orquestada** por `saga-orchestrator-service`:

1. reserva: conector `RESERVED`;
2. débito del saldo estimado;
3. activación del cargador.

`energy-dispatch` lee `SIMULATE_CHARGER_HARDWARE_FAULT` de la tabla de flags **de su ambiente**. Si está activa, el paso 3 falla con `E-HW-001` y el orquestador ejecuta, en orden inverso:

- `REFUND_DEBIT`: billing marca el débito `REFUNDED` y escribe un `REFUND` en el libro mayor;
- `RELEASE_RESERVATION`: la reserva pasa a `RELEASED` y el conector a `AVAILABLE`.

La SAGA termina en `COMPENSATED`, con todo su historial de eventos persistido.

**Situación local que hay que conocer.** En `test` la flag de falla **ya está activa** (`True`, versión 1, sembrada por Terraform). Localmente solo `dev` tiene clúster por la memoria (L-11): `test` tiene tablas, red y API Gateway, pero no pods. Hay dos formas de demostrarlo.

#### Opción A (recomendada, ensáyala antes): encender el clúster de `test` en local

Es el mismo camino que el pipeline usa en el runner con `TF_VAR_eks_enabled_override=true`, verificado en GitHub en el despliegue de `test`. **En este equipo no se ha ejecutado para `test`.**

```bash
docker stop floci-aws-eks-aegisvolt-dev                              # libera ~1,3 GB (L-11); conserva el estado
export TF_VAR_eks_enabled_override=true                              # enciende EKS sin editar envs/test.tfvars
scripts/floci/terraform-live.sh test                                 # plan: + clúster, node group, addon, asociaciones. Revisa que no destruya nada
scripts/floci/terraform-live.sh test apply
scripts/floci/k8s-deploy.sh test                                     # imágenes → ECR → clúster test → Cognito de test → humo
scripts/floci/k8s-verify.sh test                                     # con la flag activa espera COMPENSATED y la métrica SagaCompensated
```

Luego repite el bloque de variables y los helpers con `ENV=test`, y sigue los pasos de abajo.

Para volver a `dev`:

```bash
docker stop floci-aws-eks-aegisvolt-test
docker start floci-aws-eks-aegisvolt-dev                             # si k3s no arranca: L-10
```

Mientras el clúster de `test` siga en el estado, planifica `test` con `TF_VAR_eks_enabled_override=true`. Sin la variable, el plan querría borrar el clúster, y `terraform-live.sh` lo rechaza.

#### Opción B: sin encender `test`

Se combinan tres evidencias reales, y se dice explícitamente que se combinan:

1. **Aislamiento de la flag en `test`:** `scripts/flags/set.sh test SIMULATE_CHARGER_HARDWARE_FAULT true` y `flag test`, `flag prod` (el helper) muestran que solo cambia `test`.
2. **La misma SAGA en vivo en `dev`,** con los pasos de abajo y `ENV=dev`. El código y las imágenes son idénticos en todos los ambientes; solo cambian la tabla y la flag.
3. **[GitHub] El despliegue de `test`** (`deploy-floci`, commit `9626f5e`, artefacto `deploy-test-reports`, `verify.md`): una SAGA real por la web en el clúster temporal de `test` terminó `COMPENSATED`, como exige la flag activa en `test`.

Ese informe **no** incluye los ítems de DynamoDB. Los ítems se muestran en vivo con la opción A o, en `dev`, con la opción B.

#### Pasos de la demostración (con `ENV` = `test` en la opción A, o `dev`)

```bash
# 1. Estado de la flag en cada ambiente (valor/versión)
echo "dev=$(flag dev) test=$(flag test) prod=$(flag prod)"

# 2. Activar la flag en el ambiente, con la mutación de administrador (si ya está activa, la versión no cambia)
set_flag true                                   # {"key":"SIMULATE_CHARGER_HARDWARE_FAULT","enabled":true,"version":N}
sleep 6                                         # caché de flags en los servicios: ≤ 5 s

# 3. Disparar la mutación GraphQL con un correlation_id propio
CORR=$(cat /proc/sys/kernel/random/uuid); echo "correlation_id=$CORR"
R=$(reserve "$CORR"); echo "$R"                 # {"status":"COMPENSATED","sagaId":"saga_…"}
SAGA=$(jq -r .sagaId <<<"$R")

# 4. Tabla de la SAGA: estado, motivo, plan de compensación e historial
aws dynamodb get-item --table-name aegisvolt-sagas-$ENV --key "{\"PK\":{\"S\":\"SAGA#$SAGA\"},\"SK\":{\"S\":\"META\"}}" \
  --query 'Item.{status:status.S,failureReason:failureReason.S,failedStep:failedStep.S,plan:compensationPlan}'
aws dynamodb query --table-name aegisvolt-sagas-$ENV --key-condition-expression 'PK = :pk AND begins_with(SK, :e)' \
  --expression-attribute-values "{\":pk\":{\"S\":\"SAGA#$SAGA\"},\":e\":{\"S\":\"EVT#\"}}" \
  --query 'Items[].[SK.S,type.S,step.S,status.S]' --output text
#   EVT#000000 SAGA_STARTED … EVT#000006 STEP_FAILED ACTIVATION COMPENSATING → COMPENSATION_STARTED
#   → COMPENSATION_STEP_STARTED/SUCCEEDED REFUND_DEBIT → … RELEASE_RESERVATION → EVT#000012 SAGA_COMPENSATED

# 5. Facturación: débito REFUNDED y libro mayor con DEBIT y REFUND del mismo correlation_id
aws dynamodb scan --table-name aegisvolt-billing-$ENV --filter-expression "sagaId = :s" \
  --expression-attribute-values "{\":s\":{\"S\":\"$SAGA\"}}" --query 'Items[].[PK.S,SK.S,status.S,type.S,amountMinor.N,balanceAfterMinor.N]' --output text
#   DEBIT#dbt_…  META  REFUNDED
#   REFUND#rfd_… META  (amountMinor = el del débito)
#   WALLET#<flota> TX#…wtx_debit-…  DEBIT  → balanceAfterMinor X
#   WALLET#<flota> TX#…wtx_refund-… REFUND → balanceAfterMinor X + importe

# 6. Reservas: reserva RELEASED y conector AVAILABLE
aws dynamodb scan --table-name aegisvolt-reservations-$ENV --filter-expression "sagaId = :s" \
  --expression-attribute-values "{\":s\":{\"S\":\"$SAGA\"}}" --query 'Items[].[PK.S,status.S]' --output text
aws dynamodb query --table-name aegisvolt-reservations-$ENV --key-condition-expression 'PK = :pk' \
  --expression-attribute-values "{\":pk\":{\"S\":\"STATION#$STATION\"}}" --query 'Items[].[SK.S,status.S]' --output text
#   RES#res_… META RELEASED · CONN#cn_01 AVAILABLE (si después corre una SAGA COMPLETED, ese conector pasa a OCCUPIED)

# 7. Despacho: sesión FAILED por la falla simulada
aws dynamodb scan --table-name aegisvolt-dispatch-$ENV --filter-expression "sagaId = :s" \
  --expression-attribute-values "{\":s\":{\"S\":\"$SAGA\"}}" --query 'Items[].[PK.S,status.S,faultCode.S]' --output text
#   SESSION#ses_… FAILED E-HW-001

# 8. Prod no cambió
echo "prod=$(flag prod)"
```

Resultado de la demostración del 2026-11-19 en `dev` (`audit-20261119/23-live-flag-saga.log`):

- SAGA `COMPENSATED`;
- billing: débito `REFUNDED`, más los movimientos `TX#…wtx_debit-…` y `TX#…wtx_refund-…`;
- reservations: `RELEASED`;
- `prod` siguió en `False/1`;
- al apagar la flag, la siguiente SAGA terminó `COMPLETED`.

Los nombres de atributos de estas consultas se comprobaron el 2026-11-19 contra los ítems reales de la SAGA `saga_c636bd92…` en `dev`.

**En la consola web** (complemento visual):

1. Abre `http://127.0.0.1:18090` (Traefik) y entra como `operador`.
2. En **Carga**, inicia una carga: termina **Compensada**.
3. En **Observabilidad**, revisa los eventos, el plan de compensación y el `correlation_id`.
4. En **Transacciones**, aparecen el débito y el reembolso.

**Archivos:** [`services/saga-orchestrator/src/application/saga-executor.ts`](../services/saga-orchestrator/src/application/saga-executor.ts) (plan de compensación y resultados aceptables por paso, líneas 25–26), `services/energy-dispatch/src/application/use-cases/start-charging-session.ts` (lectura de la flag), [`services/billing-wallet/src/application/use-cases/refund-wallet.ts`](../services/billing-wallet/src/application/use-cases/refund-wallet.ts), `services/station-reservation/src/application/use-cases/release-reservation.ts`. Diseño: [02-saga.md](architecture/02-saga.md).

**Floci frente a AWS real.** DynamoDB, con escrituras condicionales y transacciones, es **[Floci · funcional]**: los ítems que se muestran son reales.

**Repreguntas probables**

- *¿Por qué orquestación y no coreografía?* El flujo es lineal, con un paso pivote (la activación) y compensaciones en orden inverso. Un orquestador deja el estado y el historial en un solo lugar consultable por la web y Prefect, y evita dependencias cíclicas de eventos entre servicios ([ADR-0003](adr/0003-saga-orquestada-maquina-estados-persistente.md)).
- *¿Y si falla el paso 2?* Fondos insuficientes: billing responde 422 `INSUFFICIENT_FUNDS`, el débito queda `REJECTED_INSUFFICIENT_FUNDS` sin movimiento en el libro mayor, y el orquestador solo libera la reserva (`compensationPlan: [RELEASE_RESERVATION]`). Está cubierto por el E2E ([saga-demo.md §2.2](runbooks/saga-demo.md#22-fondos-insuficientes--liberación-de-la-reserva--compensated)).
- *¿Es un rollback?* No. Cada servicio confirmó su paso en su tabla. La compensación es otra operación de negocio, idempotente y registrada: un reembolso no borra el débito.

### 6.3.2 "¿Cómo evita su implementación de SAGA problemas de falta de idempotencia si un mensaje o petición de compensación se procesa dos veces?"

**Respuesta en 30 segundos.** Hay cuatro mecanismos ([ADR-0005](adr/0005-idempotencia-ids-pregenerados-y-tombstones.md), [ADR-0022](adr/0022-billing-wallet-ledger-atomico-y-compensaciones.md)):

1. **Identificadores pre-generados.** El orquestador decide el `debitId` y el `reservationId` **antes** de llamar, y los guarda en la SAGA. Un reintento usa el mismo id.
2. **Escrituras condicionales en DynamoDB.** El reembolso es una `TransactWriteItems` con `ConditionExpression: status = :debited AND version = :expectedVersion` sobre el débito y `attribute_not_exists(PK)` sobre el movimiento `REFUND`. Si llegan dos reembolsos a la vez, solo uno cumple la condición; el otro recibe `ConditionalCheckFailedException`.
3. **Respuestas idempotentes.** Una compensación repetida devuelve `ALREADY_REFUNDED` o `ALREADY_RELEASED` sin mover el saldo. El orquestador acepta esos resultados como éxito.
4. **Tombstones.** Si una compensación llega antes que la operación original, deja una marca (`VOIDED`) y la operación posterior no se aplica.

Además, la petición inicial lleva `idempotency-key`: repetir la mutación devuelve la misma SAGA y no cobra dos veces.

**Demostración**

```bash
# Automática (E2E, tablas temporales en Floci)
REQUIRE_INTEGRATION=true pnpm test:e2e
jq '.summary.saga' tests/e2e/.evidence/04-compensacion-repetida.json

# Manual, sobre la SAGA compensada de 6.3.1 (mismo ENV, port-forward 18101 y 18102 de los helpers):
read DEBIT RES < <(aws dynamodb get-item --table-name aegisvolt-sagas-$ENV \
  --key "{\"PK\":{\"S\":\"SAGA#$SAGA\"},\"SK\":{\"S\":\"META\"}}" --query 'Item.[debitId.S,reservationId.S]' --output text)
movs() { aws dynamodb query --table-name aegisvolt-billing-$ENV --key-condition-expression 'PK = :pk AND begins_with(SK, :t)' \
  --expression-attribute-values "{\":pk\":{\"S\":\"WALLET#$DEMO_FLEET\"},\":t\":{\"S\":\"TX#\"}}" --query Count --output text; }
echo "movimientos antes: $(movs)"
H=(-H 'content-type: application/json' -H "x-correlation-id: $CORR" -H "x-saga-id: $SAGA")
curl -sS -X POST "http://127.0.0.1:18102/v1/debits/$DEBIT/refund" "${H[@]}" -d '{"reason":"CHARGER_HARDWARE_FAULT"}' | jq -c '{outcome}'
curl -sS -X POST "http://127.0.0.1:18101/v1/reservations/$RES/release" "${H[@]}" -d '{"reason":"CHARGER_HARDWARE_FAULT"}' | jq -c '{outcome}'
echo "movimientos después: $(movs)"
#   {"outcome":"ALREADY_REFUNDED"} · {"outcome":"ALREADY_RELEASED"} · mismo número de movimientos
```

Verificado el 2026-11-19 en `dev`, sobre la SAGA compensada `saga_c636bd92…`: `ALREADY_REFUNDED`, `ALREADY_RELEASED` y 17 movimientos antes y después.

Evidencia registrada ([saga-demo.md §2.4](runbooks/saga-demo.md#24-compensación-procesada-dos-veces-63)): `refund` → `ALREADY_REFUNDED`, `release` → `ALREADY_RELEASED`; el saldo (`47000000`) y el número de movimientos (2) no cambian.

**Casos límite que también cubre** (E2E, [saga-demo.md](runbooks/saga-demo.md)):

- **El orquestador muere con el débito aplicado pero sin respuesta.** Otro proceso retoma la SAGA cuando vence el *lease*, repite el paso con el mismo `dbt_…`, billing responde con la operación ya registrada, y queda **un solo** `DEBIT` (§2.5).
- **La compensación falla.** La SAGA queda `COMPENSATION_FAILED` con `nextAttemptAt`, y el conector sigue `RESERVED`: no se marca como compensada sin estarlo. Al recuperarse billing, el reintento automático la completa (§2.6).

**Archivos:** [`services/billing-wallet/src/infrastructure/dynamodb/dynamodb-wallet-repository.ts`](../services/billing-wallet/src/infrastructure/dynamodb/dynamodb-wallet-repository.ts) (`NEW_ITEM = 'attribute_not_exists(PK)'` en la línea 53; condición del reembolso en la línea 177; transacción en la línea 260), `services/billing-wallet/src/domain/wallet/wallet-service.ts` (`ALREADY_REFUNDED`, líneas 95–122), `services/saga-orchestrator/src/application/saga-executor.ts` (líneas 25–26).

---

## 6.4 Observabilidad y capa de presentación (20 %)

### 6.4.1 "Muestre en Prefect la ejecución del flujo de observabilidad y rastree en CloudWatch el `correlation_id` de una transacción SAGA fallida."

**Respuesta en 30 segundos.** Cada proceso escribe logs JSON con estos campos:

- `timestamp`, `level`, `service_name`, `environment`;
- `correlation_id`, `saga_id`, `operation`, `message`;
- `error` tipado.

Fluent Bit los envía a `/aegisvolt/<env>/<servicio>`, un grupo por servicio y por ambiente. El `correlation_id` se propaga por cabeceras HTTP a los cinco servicios. Prefect ejecuta dos tipos de flows:

- `environment_health_monitor`, para los tres ambientes;
- auditorías de consistencia de SAGA, reservas y billing, de solo lectura por las APIs de los servicios. Publica métricas en `AegisVolt/Audit`.

**Demostración**

1. **Prefect** [Floci · funcional para `dev`]. Sigue [observability.md §6.1](runbooks/observability.md#61-contra-el-clúster-dev-de-floci): `port-forward` a los cinco Services, servidor de Prefect en `http://127.0.0.1:4200` y ejecución de:

   ```bash
   .venv/bin/python -c "from aegisvolt_observability.flows import environment_health_monitor as f; f(environments=['dev','test','prod'])"
   .venv/bin/python -c "from aegisvolt_observability.flows import saga_consistency_audit as f; f(environment='dev')"
   ```

   En el dashboard: **Runs** (cada task por servicio), **Artifacts** (el informe por ambiente) y los logs `WARNING` con la regla de cada hallazgo. Resultado esperado: `dev` OPERATIONAL; `test` y `prod` DOWN porque no tienen clúster local (es su estado real, L-11); auditoría de SAGA con 0 hallazgos, contando la SAGA compensada de 6.3.1 como consistente.

2. **CloudWatch, por `correlation_id`** [Floci · funcional], con el `$CORR` de 6.3.1. Si es otra sesión, toma el `correlation_id` de la página **Observabilidad** de la consola.

   ```bash
   G=/aegisvolt/$ENV
   for g in graphql-api saga-orchestrator-service station-reservation-service billing-wallet-service energy-dispatch-service; do
     printf '%-30s %s eventos\n' "$g" "$(aws logs filter-log-events --log-group-name $G/$g --filter-pattern "\"$CORR\"" --query 'length(events)' --output text)"
   done
   # La traza ordenada en los 5 grupos (Logs Insights fields/filter/sort)
   QID=$(aws logs start-query --start-time $(date -d '-1 hour' +%s) --end-time $(date +%s) \
     --log-group-names $G/graphql-api $G/saga-orchestrator-service $G/station-reservation-service $G/billing-wallet-service $G/energy-dispatch-service \
     --query-string "fields @timestamp, @log, operation, event, message | filter correlation_id = \"$CORR\" | sort @timestamp asc" \
     --query queryId --output text); sleep 3; aws logs get-query-results --query-id $QID
   # Solo el paso fallido, con su error tipado
   aws logs filter-log-events --log-group-name $G/saga-orchestrator-service \
     --filter-pattern "{ (\$.correlation_id = \"$CORR\") && (\$.event = \"STEP_FAILED\") }" --query 'events[].message' --output text | jq .
   # Métrica de la SAGA compensada
   aws cloudwatch get-metric-statistics --namespace AegisVolt/$ENV --metric-name SagaCompensated --statistics Sum \
     --start-time $(date -u -d '-1 hour' +%FT%TZ) --end-time $(date -u +%FT%TZ) --period 300
   ```

   Resultado del 2026-11-19: el `correlation_id` apareció en los cinco grupos (graphql-api 2 eventos, orquestador 14, station 3, billing 2, energy 2), con los eventos `SAGA_STARTED`, `STEP_FAILED`, `COMPENSATION_*` y `SAGA_COMPENSATED`.

**Archivos:** [`packages/logger`](../packages/logger) (esquema de campos), [ADR-0028](adr/0028-logging-estructurado-operation-errores-tipados.md), `infra/k8s` (Fluent Bit), [`infra/terraform/modules/cloudwatch/main.tf`](../infra/terraform/modules/cloudwatch/main.tf) (log groups, *metric filters* y alarmas), [`prefect/src/aegisvolt_observability/`](../prefect/src/aegisvolt_observability/) (flows, tasks y reglas).

**Floci frente a AWS real.**

- `FilterLogEvents`, Logs Insights con `fields`/`filter`/`sort`, *metric filters* y alarmas de una métrica son **[Floci · funcional]**.
- Logs Insights `stats` y EMF no funcionan en Floci (L-09). Por eso las métricas salen de *metric filters* y Prefect calcula las tasas en el cliente.
- Limitación propia (L-18): Prefect no trae una configuración versionada para el clúster. Se usa una copia temporal de `local.toml` con los puertos del `port-forward`. En **[AWS real]** apuntaría a los Services internos o a la API PRIVATE.

### 6.4.2 "Cambie el estado de una Feature Flag en `dev` sin redesplegar el código y muestre cómo cambia el comportamiento en el Frontend web de `dev` mientras `prod` permanece intacto."

**Respuesta en 30 segundos.** Las flags viven en una tabla DynamoDB **por ambiente** (`aegisvolt-feature-flags-dev`, `-test`, `-prod`). Cada proceso deriva su tabla de `APP_ENV`, que fija el despliegue; si se configura otra tabla, el proceso no arranca. Los servicios leen las flags con una caché de 5 s, así que un cambio se aplica sin reiniciar ni redesplegar. Solo un administrador puede cambiarlas, por la mutación `updateFeatureFlag`, con versión condicional y auditoría (`changedBy`, `correlationId`, `environment`).

**Demostración** (clúster `dev`, consola por Traefik en `http://127.0.0.1:18090`)

1. Estado inicial: `echo "dev=$(flag dev) prod=$(flag prod)"`.
2. En el navegador, entra como `admin`. En **Feature flags**:
   - la página muestra el ambiente **DEV**, que lo informa el backend;
   - activa `SIMULATE_CHARGER_HARDWARE_FAULT` y confirma;
   - la versión sube y la auditoría muestra quién, cuándo y con qué `correlation_id`.
3. Sin tocar Kubernetes, comprueba que nada se redesplegó:

   ```bash
   k -n aegisvolt get pods -o custom-columns=POD:.metadata.name,INICIO:.status.startTime,REINICIOS:.status.containerStatuses[0].restartCount
   ```

4. Cierra sesión y entra como `operador`. En **Carga**, inicia una carga: termina **Compensada** (falla del cargador, reembolso y liberación). En **Observabilidad** aparece el plan de compensación.
5. `prod` intacto: `echo "dev=$(flag dev) prod=$(flag prod)"` → `dev=True/<n+1>` y `prod=False/1`. La auditoría de `prod` sigue vacía:

   ```bash
   aws dynamodb query --table-name aegisvolt-feature-flags-prod --key-condition-expression 'PK = :pk AND begins_with(SK, :a)' \
     --expression-attribute-values '{":pk":{"S":"FLAG#SIMULATE_CHARGER_HARDWARE_FAULT"},":a":{"S":"AUDIT#"}}' --query 'Count'
   ```

6. Apaga la flag desde la consola. La siguiente carga termina **Completada**.

Sin navegador, lo mismo con los helpers: `set_flag true`, `reserve "$(uuidgen)"`, `set_flag false`. Es exactamente la secuencia de `audit-20261119/23-live-flag-saga.log`.

**Qué decir con transparencia.**

- Localmente **no hay frontend de `prod` en ejecución**: solo `dev` tiene clúster (L-11). Que `prod` "permanece intacto" se demuestra con su tabla (misma versión y sin auditoría).
- Además, la prueba automática [`apps/graphql-api/test/integration/feature-flags-isolation.int.test.ts`](../apps/graphql-api/test/integration/feature-flags-isolation.int.test.ts) usa un "despliegue" del API por ambiente. Cambia `dev` y verifica que los ítems de `test` y `prod` no cambian y que sus lectores no ven el cambio:

  ```bash
  REQUIRE_INTEGRATION=true pnpm --filter @aegisvolt/graphql-api test:integration
  ```

- Floci no evalúa IAM (L-08). El aislamiento no depende de políticas, sino de una tabla por ambiente ligada a `APP_ENV`. En **[AWS real]** el rol de cada pod solo podría leer la tabla de su ambiente (declarado en el módulo `iam`).

**Archivos:** [`packages/feature-flags`](../packages/feature-flags) (catálogo, tabla por ambiente y lector con caché), [ADR-0025](adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md), `apps/web/src` (página de flags con polling), [feature-flags-demo.md](runbooks/feature-flags-demo.md).

**Repreguntas probables**

- *¿Cuánto tarda en verse el cambio?* Como máximo el TTL de la caché de los servicios (5 s por defecto, `FEATURE_FLAGS_CACHE_TTL_MS`) más el intervalo de *polling* de la consola.
- *¿Qué pasa si dos administradores cambian la flag a la vez?* La escritura exige la versión esperada: uno gana y el otro recibe un conflicto (409). Está probado en la integración y con `scripts/flags/set.sh --expected-version`.
- *¿Qué hacen las otras dos flags?*
  - `ENABLE_DYNAMIC_SURGE_PRICING` aplica un recargo en la ventana pico (17:00–21:00, hora de Bogotá); por eso la falla de hardware es la más demostrable.
  - `ENABLE_FAST_CHARGE_BOOST` habilita la reserva prioritaria: con la flag apagada, pedirla falla con `FAST_CHARGE_BOOST_DISABLED`.

---

## Resumen: qué no se puede demostrar y por qué

| Requisito | Estado | Cómo responder |
| --- | --- | --- |
| Filtrado real por SG, rutas y VPCE | **[Floci · metadatos]** (L-01, L-14) | Mostrar la configuración (`describe-*`), el recorrido del paquete y el aislamiento real de las NetworkPolicies |
| API PRIVATE bloqueada fuera del VPCE | **[Floci · metadatos]** (L-02) | Mostrar la *resource policy* con `aws:SourceVpce` |
| EKS administrado y endpoint privado | k3s de un nodo (L-03) | Mostrar el clúster `ACTIVE` en las subredes privadas y los flags del endpoint |
| Clúster en `test` y `prod` a la vez en local | Memoria (L-11) | Opción A de 6.3.1; en GitHub, cada ambiente tiene su clúster temporal |
| Despliegue en AWS real | No realizado (reglas del proyecto) | El pipeline aplica en un Floci temporal (L-15) |
| Cognito en Terraform | Fuera de Terraform (L-13) | Lo crea `scripts/floci/bootstrap-env.sh`; está propuesto un módulo `identity` |
| Rechazo GH013 capturado | Reglas verificadas por API; push sin capturar | Ensayar la sección 6.2.1 y guardar la salida |
