# Kubernetes

Manifiestos Kustomize ([ADR-0012](../../docs/adr/0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md), [ADR-0031](../../docs/adr/0031-contenedores-kubernetes-floci.md)). Despliegue, inspección y troubleshooting: [runbook](../../docs/runbooks/kubernetes.md).

| Directorio | Contenido |
| --- | --- |
| `base/namespace/` | Namespace `aegisvolt` (Pod Security Admission `restricted`) y políticas comunes: `default-deny-all`, `allow-dns-egress`, `allow-aws-egress` |
| `base/apps/<app>/` | Por unidad: Deployment (probes, recursos, security context, preStop), Service `ClusterIP` 80→8080, ServiceAccount sin token, NetworkPolicy y `config.env` (ConfigMap no sensible) |
| `base/logging/` | Fluent Bit 5.1.5 → CloudWatch `/aegisvolt/<env>/<servicio>` ([ADR-0029](../../docs/adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md)) |
| `components/floci/` | Solo local: Service `floci` + EndpointSlice (IP inyectada al desplegar), `AWS_ENDPOINT_URL`, Secret de credenciales **ficticias**, `allow-floci-egress`, salida de Fluent Bit por HTTPS a Floci |
| `components/canary/` | Canary de graphql-api ([ADR-0032](../../docs/adr/0032-canary-argo-rollouts-traefik-cloudwatch.md)): `Rollout` con `workloadRef` al Deployment (que queda en 0 réplicas), Service `graphql-api-canary`, `TraefikService` con pesos, `IngressRoute` y `AnalysisTemplate` (disponibilidad + tasa de error en CloudWatch) |
| `platform/argo-rollouts`, `platform/traefik` | Controladores de clúster fijados por digest: Argo Rollouts v1.10.1 y Traefik v3.7.16. Los manifiestos oficiales se descargan y verifican por sha256 con `scripts/k8s/vendor-platform.sh` (no se versionan) |
| `platform/local` | Solo local: acceso del controlador de Argo al CloudWatch de Floci (`AWS_ENDPOINT_URL`, Secret ficticio, Service `floci`) |
| `overlays/dev`, `overlays/test`, `overlays/prod` | `APP_ENV`, tablas `aegisvolt-<dominio>-<env>`, nivel de log y ambiente del colector. `prod`: 2 réplicas, más CPU y PodDisruptionBudgets |

Unidades: `station-reservation-service`, `billing-wallet-service`, `energy-dispatch-service`, `saga-orchestrator-service`, `graphql-api` y `web`.

- **Imágenes:** no se fijan en Git. `scripts/floci/k8s-deploy.sh` genera una kustomization con `images` (ECR de Floci, `sha-<commit>`) sobre el overlay.
- **Identidad del ambiente:** el ConfigMap `aegisvolt-identity` (emisor, JWKS y app client de Cognito) lo publica el despliegue; en AWS real, Terraform.
- **Etiquetas obligatorias de cada workload:** `app.kubernetes.io/part-of: aegisvolt` y `app.kubernetes.io/name: <service_name>`, de las que dependen los log groups y las NetworkPolicies.
- **Canary:** solo graphql-api, que recibe el tráfico externo, se despliega con Argo Rollouts y reparto por peso en Traefik. El resto usa `RollingUpdate`, que no es canary. El despliegue etiqueta la plantilla con `version=<etiqueta>`, que se devuelve en `x-service-version`. Demostración: [runbook](../../docs/runbooks/canary-rollback.md).

```bash
kubectl kustomize infra/k8s/overlays/dev       # renderizar
scripts/floci/k8s-deploy.sh dev                # desplegar en el EKS (k3s) de Floci
scripts/floci/k8s-verify.sh dev                # verificar operación
scripts/floci/canary-demo.sh dev success       # canary: 20 % → 50 % → 100 %
scripts/floci/canary-demo.sh dev failure       # canary con error inducido → abort
```
