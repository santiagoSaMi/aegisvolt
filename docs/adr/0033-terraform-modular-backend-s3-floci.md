# ADR-0033: Terraform modular, backend S3 con bloqueo nativo, workspaces y destino Floci aislado

- **Estado:** Aceptado
- **Fecha:** 2026-11-15
- **Concreta:** [ADR-0011](0011-terraform-workspaces-backend-s3-bootstrap.md) (workspaces, backend S3, bootstrap), [ADR-0010](0010-red-apigw-vpc-link-nlb-y-vpce.md) (red y entrada) y [ADR-0012](0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md) (clúster por ambiente; decide Pod Identity)

## Contexto

§2.4 exige:

- toda la infraestructura en módulos de Terraform;
- estado remoto en S3 con versionado;
- un workspace por ambiente y nombres parametrizados;
- VPC con subredes públicas y privadas y VPCE;
- DynamoDB por servicio y ambiente.

El criterio de IaC pesa el 30 % de la evaluación. Hasta esta fase solo la observabilidad estaba en Terraform. Las tablas, el clúster EKS y los repositorios ECR los creaban scripts con AWS CLI.

## Verificación previa (2026-11-15)

| Pregunta | Resultado |
| --- | --- |
| Versiones | Terraform **1.17.1** y provider AWS **6.71.0** (ambos del 2026-10-28). 1.17.2 y 6.73.0 (del 2026-11-11) no cumplen la antigüedad mínima de 14 días. Terraform 1.17.1 se instaló verificando SHA256SUMS y la firma PGP de HashiCorp (huella `C874 011F … 72D7 468F`). |
| Guía de Floci para Terraform | Exige un endpoint por servicio en el provider. Documenta el backend S3 con bloqueo **DynamoDB** y no menciona `use_lockfile`. |
| Bloqueo nativo en Floci | **Funciona**: un `PutObject` con `If-None-Match: *` sobre una clave existente devuelve `PreconditionFailed`. Terraform 1.11 declaró GA `use_lockfile` y deprecó los argumentos de DynamoDB (CHANGELOG 1.11). |
| ¿El backend hereda los endpoints del provider? | **No.** El backend tiene su propia configuración (`endpoints.s3`, `use_path_style`, credenciales) en `config/floci/backend.hcl`. |
| Capacidades usadas | Todos los recursos de los módulos se crearon en Floci 2.4.0 (ver Consecuencias): VPC, subredes, NAT, rutas, VPCE Gateway e Interface, IAM, EKS (clúster, node group, addon, Pod Identity), NLB, VPC Link, API REST REGIONAL y PRIVATE, CloudWatch, DynamoDB con TTL, PITR y protección contra borrado, ECR con lifecycle, y S3 con versionado, SSE, *public access block*, *ownership*, política y *lifecycle*. |

## Decisión

### Raíces y estados

| Raíz | Estado (bucket `aegisvolt-tfstate`) | Contenido |
| --- | --- | --- |
| `bootstrap/` | `bootstrap/terraform.tfstate` | Bucket del estado: versionado, SSE AES256, *public access block*, `BucketOwnerEnforced`, política mínima y retención de versiones. Tiene `prevent_destroy`. |
| `global/` | `global/terraform.tfstate` (sin workspaces) | ECR compartido (para promover el mismo digest) y el ajuste de cuenta de API Gateway (rol de logs), que es único por región. |
| `live/` | `env:/<ws>/aegisvolt/terraform.tfstate` | Un workspace por ambiente: red, DynamoDB, IAM, EKS, API Gateway y CloudWatch. |

- **Bootstrap (huevo y gallina).** `scripts/floci/terraform-bootstrap.sh`:
  - la primera vez aplica con un backend local temporal (`backend_override.tf`);
  - después migra con `init -migrate-state`.
  - El estado local existente se migró así, comprobando que los recursos y outputs eran idénticos (mismo sha256 de contenido).
  - Terraform asigna un `lineage` nuevo al copiar un estado local a un backend vacío. Se informa; no se pierde información.
- **Bloqueo:** `use_lockfile = true` (objeto `<estado>.tflock` con escritura condicional). No se usa tabla DynamoDB, porque está deprecada y ya no hace falta.

### Seguridad del destino

- **Configuración local separada.** Lo de Floci vive en `config/floci/{backend.hcl,target.tfvars}` de cada raíz. No hay configuración de AWS real en el repositorio. Si existiera, viviría en `config/aws/` con credenciales OIDC del CI.
- **El provider nunca lee `~/.aws`:** `shared_config_files` y `shared_credentials_files` apuntan a `/dev/null` en el provider y en el backend. Los scripts además quitan `AWS_PROFILE` y las variables de sesión.
- **Destino validado:**
  - con `target = "floci"`, `floci_endpoint` es obligatorio y debe ser `http://localhost|127.0.0.1:<puerto>`;
  - con `target = "aws"`, debe ser `null`.
  - Las credenciales ficticias solo se usan con `floci`.
- **`allowed_account_ids`:** el provider aborta si las credenciales pertenecen a otra cuenta (en Floci, `000000000000`).
- **Barreras en los scripts:**
  - `terraform-lib.sh` rechaza cualquier URL no local escrita en `.tf`, `.hcl` o `.tfvars`;
  - los planes que destruyen o reemplazan se rechazan, salvo `--allow-destroy`;
  - ningún script ejecuta `destroy`.
- **Git:** `*.tfstate*`, `*.tfplan` y `.terraform/` están ignorados. Se versiona `.terraform.lock.hcl`.

### Workspaces no son la única frontera

1. **Estado propio por workspace:** desde `test`, los recursos de `prod` no están en el estado.
2. **Nombres con el ambiente** (`aegisvolt-<dominio>-<env>`, `aegisvolt-<env>-…`) y CIDR distinto por ambiente (10.10, 10.20 y 10.30).
3. **Configuración separada por ambiente** (`envs/<env>.tfvars`). Una precondición exige `var.environment == terraform.workspace` y rechaza el workspace `default`.
4. **Permisos:**
   - cada rol de carga de trabajo solo alcanza las tablas de su ambiente;
   - la confianza de Pod Identity exige el ARN del clúster de su ambiente;
   - las políticas de los VPCE Gateway limitan DynamoDB a las tablas del ambiente.
5. **En AWS real, una cuenta por ambiente** (`allowed_account_ids` distinto). En Floci hay una sola cuenta: limitación L-08.
6. **`prod`:** `deletion_protection` y PITR en las tablas, y un NAT por AZ.

### Módulos (`infra/terraform/modules`)

| Módulo | Contenido | Validaciones principales |
| --- | --- | --- |
| `dynamodb-table` | Tabla PK/SK, GSIs (`key_schema`), TTL, PITR, protección contra borrado | Nombre terminado en `-dev\|-test\|-prod` y GSIs únicos |
| `network` | VPC, subredes públicas `/24` y privadas `/20` en 2–3 AZ, IGW, NAT (uno o por AZ), rutas, VPCE Gateway (S3, DynamoDB) e Interface (recortados en [ADR-0034](0034-red-eks-api-gateway-terraform-floci.md) a `logs`, `monitoring`, `ecr.api`, `ecr.dkr`, `execute-api` y `eks-auth`) con SG de 443 desde las subredes privadas | CIDR `/16`, `az_count` 2–3 y políticas de endpoint no vacías |
| `iam` | Un rol por ServiceAccount con política mínima (tabla propia, flags `read` o `read_write`, permisos explícitos) | Sin acciones comodín |
| `eks` | Roles del plano de control y de nodos, clúster en subredes privadas (`authentication_mode = API`), node group, addon `eks-pod-identity-agent` y asociaciones de Pod Identity | Nombre `aegisvolt-<env>`, ≥ 2 subredes y sin `0.0.0.0/0` en el endpoint público |
| `api-gateway` | NLB interno, target group `ip` (Traefik), VPC Link, API REST REGIONAL y PRIVATE (`aws:SourceVpce`), `{proxy+}` HTTP_PROXY por VPC_LINK, stage por ambiente con logs de acceso JSON y throttling | Timeout ≤ 29 s y precondición de VPCE para la API PRIVATE |
| `cloudwatch` | (antes `observability`, [ADR-0029](0029-cloudwatch-fluent-bit-log-groups-metricas.md)) Log groups, metric filters, alarmas y dashboard | Retención válida |
| `ecr` | Repositorios inmutables, escaneo al subir, AES256 y *lifecycle* | ≥ 5 imágenes conservadas |

- Los módulos aceptan el provider `>= 6.71.0, < 7.0.0`; cada raíz fija `6.71.0` y el lock file.
- **Pod Identity en lugar de IRSA** (decisión pendiente en ADR-0012). No necesita proveedor OIDC por clúster ni thumbprints, que obligarían a consultar endpoints reales de AWS. La confianza se limita con `aws:SourceAccount` y `aws:SourceArn` del clúster.
- **Canary (ADR-0032):** el controlador de Argo recibe `cloudwatch:GetMetricData` con recurso `*`, porque esa acción no admite permisos a nivel de recurso.

### Adopción de lo existente (sin recrear ni perder datos)

- `scripts/floci/terraform-adopt.sh` importa lo que existe y aún no está en el estado:
  - los 6 repositorios ECR, con sus imágenes;
  - las 5 tablas de `dev`, con sus datos, y la tabla de flags de `test` y `prod`;
  - los ítems de flags, con su valor **actual**.
- Cada plan posterior se revisó: no destruye ni reemplaza nada.
- **Semilla de flags:** `aws_dynamodb_table_item` con `ignore_changes = [item]`. Un ambiente nuevo nace con el valor inicial de `feature-flags.json`; uno existente conserva el valor operativo (por ejemplo `ENABLE_DYNAMIC_SURGE_PRICING` de `dev`, en su versión 3). Una prueba (`packages/feature-flags/test/terraform-catalog.test.ts`) garantiza que el JSON coincide con el catálogo de TypeScript.
- **Renombre `observability` → `cloudwatch`** con un bloque `moved`: los 28 recursos de cada ambiente se movieron sin recrearse.
- **Clúster EKS de `dev`** (autorizado por el usuario): el del script, en la VPC por defecto, se borró. Terraform lo recreó en la VPC de `dev`, porque Floci no implementa `UpdateClusterConfig`. La aplicación se redesplegó con `k8s-deploy.sh`.
- **`eks.enabled = false` en `test` y `prod`:** no caben tres k3s en la memoria de la máquina local (L-11). El módulo es el mismo y se valida con un plan que lo enciende.

## Alternativas

1. **Bloqueo con DynamoDB, como en la guía de Floci.** Funciona, pero está deprecado desde Terraform 1.11 y obliga a crear otra tabla antes de `init`.
2. **Un directorio por ambiente.** Aísla mejor, pero la especificación exige workspaces.
3. **Un único archivo de provider con endpoints a Floci, como antes.** No separa el destino local de uno real ni impide leer `~/.aws`.
4. **IRSA.** Requiere `aws_iam_openid_connect_provider` con thumbprint, obtenido de un endpoint real o fijado a mano, y un rol por clúster y OIDC. Pod Identity es la opción actual de EKS.
5. **Bloques `import` en el código en vez del script de adopción.** Fallan en los ambientes donde el recurso no existe y dejan historia operativa en la configuración. La adopción es un paso único y auditable (registro en `.tmp/terraform-adopt-*.log`).
6. **ECR por ambiente.** Obliga a copiar la imagen entre registros y rompe la promoción del mismo digest.

## Consecuencias

- **Positivas:**
  - Toda la infraestructura de `dev`, `test` y `prod` (salvo Cognito, L-13) está en módulos y en estado remoto versionado y con bloqueo.
  - El destino local no puede alcanzar AWS real por configuración, por validación, por cuenta y por script.
  - Planes idempotentes: el segundo plan de `dev` sale sin cambios.
- **Negativas:**
  - Floci no aplica la red, las políticas IAM, las de S3 ni la de la API PRIVATE (L-01, L-02, L-08, L-12): se verifican como configuración.
  - EKS solo existe en `dev` (L-11).
  - El provider emite un aviso de `protocol_version` en el target group TCP, porque Floci devuelve ese atributo. Hoy no es un error.
  - Terraform 1.17.1 está instalado en `~/.local/bin`; la versión anterior quedó como `terraform-1.17.2`.

## Evidencia

[docs/runbooks/terraform.md](../runbooks/terraform.md).
