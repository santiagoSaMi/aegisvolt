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
  - Documentar el recorrido del paquete (API Gateway → VPCE → NLB/Ingress → Service → Pod) con un diagrama y las reglas que intervienen.
  - Indicar en la sustentación que en Floci el aislamiento es declarativo, no enforced.

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
- **Propuesta:** aprovisionar el clúster con `aws_eks_cluster` en Terraform contra Floci y desplegar con `kubectl`/manifiestos sobre ese k3s. Pendiente de validar en la fase de IaC: soporte de `aws_eks_cluster`/`aws_eks_node_group` del provider contra Floci.

## L-04 · Canary con métricas de CloudWatch

- **Requisito:** §3.3 — health checks y métricas de error en CloudWatch antes de promover del 20 % al 100 %.
- **Estado:** CloudWatch Logs es funcional. **CloudWatch Metrics/Alarms no se ha probado**. Según la documentación, el evaluador soporta alarmas de una sola métrica, sin metric math.
- **Pendiente:** verificarlo en la fase de CI/CD antes de diseñar la condición de promoción.

## L-05 · API Gateway HTTP (v2) sin verificar

- **Comportamiento observado:** solo se probó `create-api`.
- **Documentación de Floci:** las integraciones `AWS_PROXY` solo invocan `SQS-SendMessage`. El resumen de la documentación indica que `HTTP_PROXY` está soportado.
- **Pendiente:** decidir entre REST v1 (verificado) y HTTP v2 en un ADR cuando se diseñe la entrada GraphQL.

## L-06 · Exposición de puertos de contenedores hermanos

- El API server de k3s se publica en `0.0.0.0:65xx` del host, no solo en loopback.
- El registry de ECR (`127.0.0.1:5100`) sigue en ejecución después de `stop.sh`.
- **Mitigación:** uso exclusivamente local. Se puede revisar `FLOCI_SERVICES_EKS_ENDPOINT_HOST` en el futuro.
