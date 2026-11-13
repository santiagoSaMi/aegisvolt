# Kubernetes

Manifiestos Kustomize ([ADR-0012](../../docs/adr/0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md), [ADR-0013](../../docs/adr/0013-canary-argo-rollouts-analisis-cloudwatch.md)):

| Directorio | Contenido |
| --- | --- |
| `base/` | Rollouts, Services, NetworkPolicies y PDB por aplicación |
| `components/floci/` | Acceso de los pods a Floci; solo para el entorno local |
| `overlays/dev`, `overlays/test`, `overlays/prod` | Réplicas, recursos y digests de imagen de cada ambiente |

Se implementa en la fase de Kubernetes. Los Dockerfiles de cada unidad desplegable llegan en esa misma fase.
