# ADR-0012: Un clúster EKS por ambiente, manifiestos con Kustomize y acceso de los pods a Floci

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.2 exige microservicios en Kubernetes (EKS en el diagrama), y los ambientes deben estar aislados. En Floci, cada clúster EKS es un contenedor k3s (verificado: ACTIVE en ~10 s, nodo `Ready`, Deployments y Services funcionales, imágenes desde el ECR de Floci).

También se verificó que los pods **no resuelven** el hostname `floci`: CoreDNS reenvía al `resolv.conf` del nodo, que apunta al DNS embebido de Docker. Sí alcanzan a Floci por IP. El `iss` de Cognito usa `floci`.

## Decisión

- **Un clúster por ambiente,** `aegisvolt-<env>`, declarado en Terraform. `prod` se puede encender bajo demanda para la demo si la memoria no alcanza (R-02).
- **Kustomize** (incluido en `kubectl`): `base/`, `components/floci/` y `overlays/<env>/`.
- **Componente `floci` (solo local):**
  - Service `floci` sin selector + EndpointSlice hacia una **IP fija** de Floci en la red `aegisvolt-floci` (requiere asignar esa IP en el compose de Floci en la fase de K8s);
  - `AWS_ENDPOINT_URL=http://floci:4566`;
  - Secret con credenciales ficticias.
  - El Service sin selector fue verificado.
- **Workloads:** probes, `resources`, `securityContext` no root, PDB y NetworkPolicies default-deny.
- **Identidad AWS de los pods:** IRSA o Pod Identity en AWS real, a decidir tras verificar su soporte en Floci. En local, credenciales ficticias.

## Alternativas

1. **Un clúster con un namespace por ambiente.** Menos memoria, pero el aislamiento es más débil y no se corresponde con "un workspace = un ambiente" en Terraform.
2. **Helm.** Útil para distribuir charts, pero innecesario para manifiestos propios (regla 10).
3. **Parche de CoreDNS (`coredns-custom`) para resolver `floci`.** Es específico de k3s y frágil. El Service sin selector es Kubernetes estándar.
4. **kind o k3d fuera de Floci.** Rompe la coherencia "EKS vía API de AWS / Terraform".

## Consecuencias

- **Positivas:** aislamiento por ambiente coherente con Terraform, y el mismo código de aplicación en local y en AWS (solo cambia el overlay).
- **Negativas:**
  - Consumo de memoria de hasta 3 clústeres (R-02).
  - Depende de una IP fija en la red Docker.
  - k3s no es EKS administrado (L-03).
