# ADR-0034: Red, EKS y API Gateway en Terraform: qué se despliega, por qué y qué demuestra Floci

- **Estado:** Aceptado
- **Fecha:** 2026-11-15
- **Concreta:** [ADR-0010](0010-red-apigw-vpc-link-nlb-y-vpce.md) (API Gateway + VPC Link + NLB y VPCE) y [ADR-0033](0033-terraform-modular-backend-s3-floci.md) (módulos)

## Contexto

La fase pide completar en Terraform VPC/networking, EKS y API Gateway, verificando servicio por servicio en Floci. Las reglas son explícitas:

1. Un VPC Endpoint no conecta API Gateway con un pod.
2. Hay que distinguir el endpoint que consume el cliente del VPCE que permite invocar una API privada.
3. Hay que comprobar enrutamiento, DNS, SG y políticas donde Floci los emule.
4. No se declara conectividad de punta a punta donde Floci solo guarda metadatos.
5. No se incluye ningún recurso de red que no se pueda demostrar o justificar.

ADR-0033 ya había creado los módulos. Esta fase los completa (SG, rutas de API, HTTPS, kubeconfig y targets), recorta lo injustificado y documenta qué es funcional y qué es metadato en Floci.

## Decisión

### Red (`modules/network`)

- **VPC** con CIDR por ambiente (`vpc_cidr`, `/16` validado): 10.10, 10.20 y 10.30. DNS support y DNS hostnames activos, porque los Interface VPCE con DNS privado los necesitan.
- **Subredes:**
  - 2 públicas `/24`, con `map_public_ip_on_launch = false`;
  - 2 privadas `/20`, con espacio para las IP de los pods con la VPC CNI;
  - repartidas en 2 AZ (`az_count` admite 3).
- **IGW** solo en la tabla pública.
- **NAT:** uno compartido en `dev` y `test` (costo) y uno por AZ en `prod` (sin punto único de falla).
  - **Justificación:** las cargas necesitan salir a destinos sin VPCE, en concreto el JWKS de Cognito para validar tokens.
- **Rutas:** la pública va al IGW. Cada subred privada tiene su tabla con su NAT.
- **VPC Endpoints:** solo los que tienen un consumidor real en la VPC.

| VPCE | Tipo | Consumidor |
| --- | --- | --- |
| `s3` | Gateway | Capas de las imágenes de ECR (política: solo el bucket de capas de ECR) |
| `dynamodb` | Gateway | Los 4 servicios y graphql-api (política: solo las tablas e índices del ambiente) |
| `logs` | Interface | Fluent Bit → CloudWatch Logs |
| `monitoring` | Interface | Argo Rollouts → `GetMetricData` (canary, ADR-0032) |
| `ecr.api`, `ecr.dkr` | Interface | Los nodos descargan imágenes |
| `execute-api` | Interface | Clientes internos invocan la API PRIVATE |
| `eks-auth` | Interface | El agente de Pod Identity obtiene credenciales (ADR-0033) |

  Se **retiraron** tres VPCE de la fase anterior:
  - `sts`: era para IRSA, que no se usa;
  - `eks`: es la API de **gestión** de EKS, no la de Kubernetes, y ninguna carga la llama;
  - `elasticloadbalancing`: no hay un controlador desplegado que la use.

  Una validación del módulo exige justificar en este ADR cualquier servicio nuevo.

- **SG de los VPCE:** 443 solo desde las dos subredes privadas.

### EKS (`modules/eks`)

- **Clúster:**
  - subredes privadas;
  - endpoint del API server privado (`endpoint_public_access = false` en los tres ambientes);
  - `authentication_mode = API`.
- **Node group** administrado en las subredes privadas.
- **Roles:**
  - plano de control: `AmazonEKSClusterPolicy`;
  - nodos: `AmazonEKSWorkerNodePolicy`, `AmazonEKS_CNI_Policy` y `AmazonEC2ContainerRegistryReadOnly`.
- **Pod Identity:** addon `eks-pod-identity-agent` y 7 asociaciones.
- **SG:**
  - los nodos de un node group administrado (y los pods, con la VPC CNI) usan el **SG del clúster** que crea EKS;
  - se añade una sola regla: entrada al puerto del ingress **desde el SG del NLB**;
  - el resto (plano de control ↔ nodos) lo gestiona EKS.
- **Kubeconfig:** salida `kubeconfig` de Terraform, sin secretos. El usuario es `exec: aws eks get-token`, con las credenciales de quien ejecuta `kubectl`. Salidas `eks_cluster_endpoint` y `eks_endpoint_access`.
- **"VPCE hacia Kubernetes" (§2.4):** para el API de Kubernetes, EKS no usa un VPCE sino el **endpoint privado del clúster** (ENIs administradas por EKS en las subredes). Es lo que configura `endpoint_private_access = true`.

### API Gateway (`modules/api-gateway`)

| Pieza | Qué es | Implementación |
| --- | --- | --- |
| Endpoint que consume el cliente | `https://<id>.execute-api.<región>.amazonaws.com/<env>` | API REST **REGIONAL**, stage `<env>`. `POST /graphql` y el SPA (`GET /` y `ANY /{proxy+}`). Siempre HTTPS. |
| API privada | API REST **PRIVATE**, invocable solo desde la VPC | `POST /graphql` y resource policy que deniega todo lo que no llega por el VPCE `execute-api` del ambiente |
| Interface VPCE `execute-api` | Puerta de **salida** de la VPC hacia API Gateway | Para clientes internos (Prefect, operación). No transporta tráfico de API Gateway hacia el clúster. |
| VPC Link | API Gateway → VPC (PrivateLink hacia un NLB) | **V1** (`aws_api_gateway_vpc_link`) hacia el NLB |
| NLB interno | Balanceo L4 en las subredes privadas | SG **sin reglas de entrada** con `enforce_security_group_inbound_rules_on_private_link_traffic = off`: el único camino es el VPC Link. Egreso solo al puerto del ingress en las subredes privadas. |
| Target group | Destino del NLB | `ip`. En AWS, las IPs de los pods de **Traefik**, que registra el AWS Load Balancer Controller (TargetGroupBinding). En Floci, la IP del contenedor k3s + NodePort `30080`, que registra `k8s-deploy.sh`. |
| Service y pod | Dentro del clúster | Traefik → `IngressRoute` → `TraefikService` (canary) → Service `graphql-api` → pod |

- **Logs de acceso** JSON en `/aegisvolt/<env>/api-gateway`, *throttling* por stage y métricas. El rol de CloudWatch de la cuenta está en `global/`.
- **VPC Link V2 para REST** (`aws_apigatewayv2_vpc_link` + `integration_target`, provider 6.71.0): se evaluó. Admite ALB y SG en el link. Se mantiene V1 porque el destino es un NLB y es la combinación verificada en Floci; V2 no se probó en Floci.
- **Sin autorizador de Cognito en API Gateway:** el JWT lo valida graphql-api (ADR-0026), probado con `UNAUTHENTICATED` sin token. Añadir un autorizador requiere el User Pool en Terraform (L-13).

### En Floci

- **Endpoint HTTPS:**
  - `https://<id>.execute-api.localhost.floci.io:4566/<env>`, validando el certificado con la CA local de Floci (TLS en modo dual, ADR-0029);
  - Floci también acepta HTTP, cosa que AWS no (L-14).
- **URI de integración:** `http://floci:<puerto del listener>`, porque el DNS `*.elb.floci` del NLB no resuelve (L-01). El puerto es distinto por ambiente, ya que los listeners comparten el contenedor de Floci.
- **Traefik:** se expone como **NodePort `30080`** solo en `platform/local`. En AWS sigue siendo `ClusterIP`.

## Verificación (Floci 2.4.0, 2026-11-15)

`scripts/floci/network-verify.sh <env>` genera la tabla requisito / implementación / evidencia / limitación ([04-networking.md](../architecture/04-networking.md#trazabilidad-requisito--implementación--evidencia--limitación)). Pasa en los tres ambientes.

- **Funcional en Floci:**
  - `POST /graphql` por **HTTPS** a la API pública → 200 con datos reales, TLS verificado y `x-service-version`;
  - sin token → `UNAUTHENTICATED`;
  - el NLB ejecuta el health check y reenvía; el target queda `healthy`;
  - kubectl funciona con el kubeconfig de Terraform.
- **Solo metadatos en Floci:**
  - VPC, subredes, rutas (sin las de prefix list de los Gateway VPCE), NAT, IGW, VPCE (ENI y DNS sintetizados);
  - SG y sus reglas, políticas de endpoint y la resource policy de la API PRIVATE: la API privada responde 200 **desde fuera de la VPC**;
  - el endpoint privado de EKS (kubectl entra desde el host);
  - IAM;
  - logs de acceso de API Gateway (no se escriben).
- **Lo que se verificó** es el **camino emulado** API Gateway → VPC Link → listener del NLB en el contenedor de Floci → contenedor k3s → Traefik → pod. **No** se verificó el aislamiento de red de AWS.

## Alternativas

1. **ALB + VPC Link V2.** Enrutado L7 y SG en el link, pero suma otro balanceador; Traefik ya hace el L7. No verificado en Floci.
2. **HTTP API (v2) con VPC Link V2.** Es más barata, pero solo las REST APIs pueden ser PRIVATE y la especificación pide un VPCE hacia API Gateway. L-05: HTTP API no verificada.
3. **Targets `instance` con NodePort** (attachment al ASG del node group). Evita el Load Balancer Controller, pero expone un NodePort en todos los nodos. En Floci no hay instancias EC2 que registrar.
4. **Regla de entrada en el NLB desde el CIDR de la VPC.** Permitiría que cualquier recurso de la VPC salte API Gateway (throttling y logs). AWS no documenta la IP de origen de un VPC Link, así que no se puede acotar mejor.
5. **Mantener todos los VPCE de la tabla de clústeres privados de EKS.** La regla 5 exige justificar cada uno; se añadirían si se instala su consumidor (por ejemplo `elasticloadbalancing` y `sts` con el Load Balancer Controller por IRSA).

## Consecuencias

- **Positivas:**
  - Cada recurso de red tiene un consumidor o un requisito.
  - El cliente usa un endpoint HTTPS de API Gateway y el clúster solo es alcanzable por VPC Link → NLB.
  - Funcional y metadato quedan separados en la evidencia.
- **Negativas:**
  - En AWS hace falta instalar el AWS Load Balancer Controller y su TargetGroupBinding; en Floci lo sustituye un script.
  - Floci no permite demostrar aislamiento: SG, políticas, API PRIVATE, endpoint privado de EKS y rutas de VPCE quedan como configuración revisable.
  - Agregar SG al NLB obligó a recrearlo, igual que en AWS. El cambio se aplicó por pasos (`-target`) para evitar un ciclo de `create_before_destroy` y un choque de nombres ([runbook](../runbooks/terraform-floci.md#6-cambios-de-red-que-recrean-recursos)).
