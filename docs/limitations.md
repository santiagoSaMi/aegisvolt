# Limitaciones conocidas del entorno local (Floci)

Verificadas con **Floci 2.4.0** el 2026-11-12. La evidencia está en [`infra/local/floci/README.md`](../infra/local/floci/README.md#matriz-de-servicios).

Cada limitación indica el requisito afectado de `proyecto_final.md` y la propuesta para cumplir el objetivo académico de forma **verificable**, sin simular que funciona. Las propuestas se concretarán en las fases correspondientes.

## L-01 · VPC Endpoints y networking privado son solo metadatos

- **Requisito:** §2.4 — VPC dedicada con subredes públicas y privadas por ambiente; VPCE hacia API Gateway y Kubernetes; Gateway/Interface VPCE para S3, DynamoDB y CloudWatch, "evitando que el tráfico interno salga a la internet pública".
- **Comportamiento observado:**
  - VPC, subnets, route tables y VPCE (Interface y Gateway) se crean y quedan `available`, con ENI y DNS sintetizados.
  - El Gateway VPCE **no añade rutas** de prefix list a la tabla de rutas.
  - El tráfico no atraviesa ninguna VPC.
- **Propuesta verificable:**
  - Declarar toda la red en Terraform (VPC, subredes, tablas de rutas, security groups, VPCE con sus políticas) y aplicarla en Floci; se verifica con `terraform plan/apply` y `aws ec2 describe-*` por ambiente.
  - Documentar el recorrido del paquete (API Gateway → **VPC Link → NLB interno** → pod) con un diagrama y las reglas que intervienen. Una corrección respecto a la versión anterior de este documento: un VPCE **no** conecta API Gateway con los pods ([04-networking.md](architecture/04-networking.md)).
  - Indicar en la sustentación que en Floci el aislamiento es declarativo, no enforced.
- **Lo que sí funciona** (verificado en la fase de arquitectura, 2026-11-12):
  - El **data plane del NLB** (ELBv2): Floci levanta el listener dentro de su contenedor (`floci:<puerto>`) y reenvía a *targets* `ip`.
  - **VPC Link** (REST): `AVAILABLE`, y la integración `HTTP_PROXY` + `VPC_LINK` se ejecuta.
  - La cadena **API Gateway → VPC Link → NLB → NodePort k3s → pod** respondió 200.
  - Diferencia con AWS: el DNS del NLB (`*.elb.floci`) no resuelve, por lo que el URI de integración local es `http://floci:<puerto>`.

## L-02 · API Gateway `PRIVATE` no aplica aislamiento

- **Requisito:** §2.4 — conexión privada hacia los endpoints de API Gateway.
- **Comportamiento observado:**
  - Una REST API `PRIVATE` asociada a un VPCE se crea correctamente, pero responde 200 desde el host, fuera de la VPC.
  - Según la documentación, Floci autentica pero no evalúa `execute-api:Invoke` ni las resource policies.
- **Propuesta verificable:**
  - Declarar la API `PRIVATE` y su resource policy (`aws:SourceVpce`) en Terraform; se verifica con `get-rest-api` y `get-rest-api --query policy`.
  - El aislamiento efectivo en local lo aplicará Kubernetes: Services `ClusterIP` y NetworkPolicies. Esto se verificará en la fase de K8s.

## L-03 · EKS es k3s, no EKS administrado

- **Requisito:** §2.2 — microservicios desplegados sobre Kubernetes (diagrama: EKS).
- **Comportamiento observado:**
  - La API de EKS (`create-cluster`, `describe-cluster`, `update-kubeconfig`) funciona y levanta un contenedor k3s v1.36.
  - Todos los node groups comparten un único nodo.
  - No se pueden actualizar la configuración ni la versión del clúster.
  - `test/test` es rechazado; hace falta una access key IAM emitida por Floci.
  - `endpointPrivateAccess=true` / `endpointPublicAccess=false` se almacenan, pero **no se aplican**: `kubectl` sigue accediendo desde el host.
- **Propuesta:** aprovisionar el clúster con `aws_eks_cluster` en Terraform contra Floci y desplegar con `kubectl`/manifiestos sobre ese k3s. Pendiente de validar en la fase de IaC: soporte de `aws_eks_cluster`/`aws_eks_node_group` del provider contra Floci.

## L-04 · Canary con métricas de CloudWatch

- **Requisito:** §3.3 — health checks y métricas de error en CloudWatch antes de promover del 20 % al 100 %.
- **Estado** (verificado el 2026-11-12):
  - Funcionan `put-metric-data`, `get-metric-statistics`, `get-metric-data` con `MetricStat` y los metric filters de Logs (un log de error genera la métrica).
  - Una expresión de *metric math* (`100*e/r`) **no devolvió resultado**, como anticipaba la documentación. Las alarmas no se han probado.
- **Propuesta:** el análisis canary calcula la tasa de error en un Job a partir de CloudWatch Logs ([ADR-0013](adr/0013-canary-argo-rollouts-analisis-cloudwatch.md)).

## L-05 · API Gateway HTTP (v2) sin verificar

- **Comportamiento observado:** solo se probó `create-api`.
- **Documentación de Floci:** las integraciones `AWS_PROXY` solo invocan `SQS-SendMessage`. El resumen de la documentación indica que `HTTP_PROXY` está soportado.
- **Pendiente:** decidir entre REST v1 (verificado) y HTTP v2 en un ADR cuando se diseñe la entrada GraphQL.

## L-07 · Los pods de k3s no resuelven el hostname `floci`

- **Comportamiento observado:**
  - CoreDNS reenvía al `resolv.conf` del nodo k3s, que apunta al DNS embebido de Docker y no es alcanzable desde los pods (`nslookup floci` → NXDOMAIN).
  - Los pods sí alcanzan a Floci por IP.
  - El `iss` de los tokens de Cognito usa `http://floci:4566/...`.
- **Propuesta (verificada):** un Service `floci` sin selector + EndpointSlice hacia una IP fija de Floci en la red `aegisvolt-floci` ([ADR-0012](adr/0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md)). La IP fija se configurará en el compose en la fase de K8s.

## L-06 · Exposición de puertos de contenedores hermanos

- El API server de k3s se publica en `0.0.0.0:65xx` del host, no solo en loopback.
- El registry de ECR (`127.0.0.1:5100`) sigue en ejecución después de `stop.sh`.
- **Mitigación:** uso exclusivamente local. Se puede revisar `FLOCI_SERVICES_EKS_ENDPOINT_HOST` en el futuro.

## L-08 · Floci no evalúa IAM: el aislamiento de flags por ambiente no depende de políticas

- **Requisito:** §2.2 y §6.4 — estado de flags independiente por ambiente; un cambio en `dev` no afecta a `prod`.
- **Comportamiento:** Floci acepta cualquier credencial ficticia y no aplica políticas IAM. Un proceso podría leer cualquier tabla si se le indicara.
- **Cómo se cumple de forma verificable ([ADR-0025](adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md)):**
  - una tabla física por ambiente;
  - la tabla de cada proceso se deriva de `APP_ENV`, que fija el despliegue, y en `dev`/`test`/`prod` no se admite otra (el proceso no arranca);
  - ninguna operación acepta un ambiente;
  - el repositorio queda ligado a una sola tabla.

  Lo demuestran la prueba de integración y el [runbook](runbooks/feature-flags-demo.md).
- **En AWS real (fase de IaC):** además, el rol IAM de cada pod solo puede leer `aegisvolt-feature-flags-<su env>`, y solo el graphql-api de ese ambiente puede escribirla. Se verificará con `terraform plan`; Floci no lo puede demostrar.
