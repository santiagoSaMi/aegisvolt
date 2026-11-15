# Kubernetes

Manifiestos Kustomize ([ADR-0012](../../docs/adr/0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md), [ADR-0013](../../docs/adr/0013-canary-argo-rollouts-analisis-cloudwatch.md)):

| Directorio | Contenido | Estado |
| --- | --- | --- |
| `base/logging/` | Fluent Bit 5.1.5 (DaemonSet, RBAC de solo lectura, configuración) → CloudWatch Logs `/aegisvolt/<env>/<servicio>` ([ADR-0029](../../docs/adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md)) | Implementado |
| `components/floci/` | Solo local: Service `floci` sin selector + EndpointSlice, salida de Fluent Bit por HTTPS a Floci (CA local), Secret con credenciales ficticias | Implementado (logging) |
| `overlays/dev`, `overlays/test`, `overlays/prod` | Ambiente del clúster (`AEGISVOLT_ENV`) | Solo logging por ahora |
| `base/<app>` | Rollouts, Services, NetworkPolicies y PDB por aplicación | Fase de Kubernetes (con los Dockerfiles) |

Para que sus logs se recojan, cada workload de AegisVolt debe llevar las etiquetas `app.kubernetes.io/part-of: aegisvolt` y `app.kubernetes.io/name: <service_name>`. El nombre debe ser el mismo `service_name` que usan los logs y el log group.

Despliegue y verificación local: `scripts/floci/logging-k8s-verify.sh --env dev`. El script crea un clúster EKS temporal en Floci, sustituye la IP de Floci (placeholder `FLOCI_IP`) y crea el ConfigMap `floci-ca` desde `infra/local/floci/data/tls/`. Requiere `scripts/floci/terraform-live.sh dev apply`.
