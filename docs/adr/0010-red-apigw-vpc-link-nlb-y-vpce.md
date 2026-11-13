# ADR-0010: Red con API Gateway REST + VPC Link + NLB interno; API PRIVATE vía VPCE `execute-api`; Gateway e Interface VPCE

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

El diagrama de la especificación dibuja "API Gateway → VPC Endpoint privado → EKS". §2.4 pide VPCE hacia API Gateway y hacia Kubernetes, y VPCE para S3, DynamoDB y CloudWatch, "evitando que el tráfico interno salga a la internet pública".

Según la documentación de AWS revisada:
- un Interface VPCE de `execute-api` sirve para que clientes **dentro** de la VPC invoquen APIs PRIVATE;
- API Gateway alcanza backends privados mediante **VPC Link** (REST: NLB y "VPC link V2"; HTTP API: ALB/NLB/Cloud Map);
- el endpoint privado del API server de EKS no es PrivateLink;
- el Interface VPCE `eks` "do[es] not support access to Kubernetes APIs".

## Decisión

- **Entrada pública:** API Gateway REST Regional → VPC Link → **NLB interno** en las subredes privadas → `graphql-api` (listener 80) y `frontend` (listener 8080).
- **API PRIVATE** (`/ops`) para consumidores internos (Prefect y operaciones), accesible por un **Interface VPCE `execute-api`**, con *resource policy* `aws:SourceVpce`, sobre el mismo VPC Link y NLB.
- **VPCE:**
  - **Gateway:** S3 y DynamoDB en las tablas de rutas privadas, con *endpoint policies* restringidas a `aegisvolt-*-<env>`.
  - **Interface:** `logs`, `monitoring`, `ecr.api`, `ecr.dkr`, `sts`, `eks`, `elasticloadbalancing`, `execute-api` y `eks-auth` si se usa Pod Identity.
- **EKS:** `endpointPrivateAccess = true`; `endpointPublicAccess = false` en `test` y `prod`.
- **VPC por ambiente** (10.10/10.20/10.30.0.0/16), 2 AZ, subredes públicas (NAT) y privadas (cargas de trabajo).
- **Local (Floci):**
  - URI de integración `http://floci:<listener>`;
  - *target* `ip` = IP del contenedor k3s + NodePort, registrado por script.
  - La cadena completa API Gateway → VPC Link → NLB → NodePort → pod fue **verificada**.

## Alternativas

1. **Solo API PRIVATE.** El navegador en Internet no podría acceder (P-03).
2. **ALB con Ingress (AWS Load Balancer Controller) + HTTP API con VPC Link V2.** Válido en AWS. Aquí se prefiere NLB porque REST es el único tipo que admite PRIVATE, y el NLB de Floci con VPC Link REST fue verificado.
3. **NLB público sin API Gateway.** Incumple la arquitectura exigida.
4. **Un *VPC endpoint service* (PrivateLink) delante del NLB.** Solo útil para consumidores de otra VPC. Opción condicionada a la respuesta del profesor (P-02).

## Consecuencias

- **Positivas:** arquitectura técnicamente correcta y explicable paquete a paquete, con su parte funcional demostrable en Floci.
- **Negativas:**
  - En Floci, VPC, VPCE, rutas, la API PRIVATE y el endpoint EKS privado son **metadatos sin aislamiento** ([limitations](../limitations.md)). El aislamiento real local se demuestra con NetworkPolicies.
  - Registrar el *target* del NLB en local requiere un script fuera de Terraform, porque la IP del contenedor k3s la asigna Docker.
