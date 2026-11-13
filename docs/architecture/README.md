# Arquitectura de AegisVolt

Diseño previo a la implementación. La fuente de requisitos es [`proyecto_final.md`](../../proyecto_final.md); cada decisión relevante tiene su ADR en [`docs/adr/`](../adr/). Las capacidades de Floci citadas aquí se verificaron con **Floci 2.4.0** el 2026-11-12 (ver [`infra/local/floci/README.md`](../../infra/local/floci/README.md) y [`docs/limitations.md`](../limitations.md)).

## Resumen

- **Componentes:** un **frontend** SPA, un **GraphQL API** (BFF), un **orquestador de SAGA** y **tres microservicios** de dominio (reservas, billetera y despacho de energía).
- **Datos:** cada servicio tiene su propia tabla DynamoDB por ambiente.
- **Proceso "Reservar y Activar Carga":** es una **SAGA orquestada** con:
  - máquina de estados persistente;
  - idempotencia mediante IDs pre-generados, escrituras condicionales y *tombstones*;
  - recuperación automática tras reinicios.
- **Cómputo:** cada ambiente (`dev`, `test`, `prod`) es un workspace de Terraform con su VPC, su clúster EKS (k3s en Floci), sus tablas y su User Pool.
- **Entrada:** API Gateway → VPC Link → NLB interno → pods.
- **Despliegues:** canary con Argo Rollouts, analizado con logs de CloudWatch.
- **Observabilidad:** CloudWatch y Prefect.

## Documentos

| # | Documento | Puntos cubiertos |
| --- | --- | --- |
| 01 | [Dominio, servicios, contratos y datos](01-dominio-y-servicios.md) | 1–6 · diagramas de contexto/contenedores y de componentes |
| 02 | [SAGA](02-saga.md) | 7, 8, 9, 12 · máquina de estados · 3 diagramas de secuencia |
| 03 | [Feature flags y seguridad](03-feature-flags-y-seguridad.md) | 10, 11 |
| 04 | [Networking](04-networking.md) | 13 · análisis API GW privado / VPCE / VPC Link / NLB / endpoint EKS · diagrama de red |
| 05 | [Terraform, EKS y canary](05-infraestructura-y-despliegue.md) | 14, 15 · diagrama de despliegue |
| 06 | [Observabilidad](06-observabilidad.md) | 16 |
| 07 | [CI/CD](07-cicd.md) | 17 |
| 08 | [Pruebas](08-testing.md) | 18 |
| 09 | [Análisis de la especificación](09-analisis-especificacion.md) | Contradicciones, ambigüedades, riesgos |
| 10 | [Modelo de dominio por bounded context](10-modelo-de-dominio.md) | Entidades, Value Objects, invariantes, estados y errores |
| — | [Contratos de integración](../contracts/README.md) | Peticiones, respuestas, errores, cabeceras, idempotencia y versiones |

## Estructura del monorepo

La estructura inicial está creada ([ADR-0018](../adr/0018-toolchain-monorepo-pnpm-node-typescript.md)). Los directorios marcados con *(fase posterior)* se crean al implementar esa fase.

```text
apps/web                              apps/graphql-api
services/saga-orchestrator            services/station-reservation
services/billing-wallet               services/energy-dispatch
packages/contracts (HTTP, OpenAPI)    packages/logger (JSON, correlation_id)   packages/config (env)
packages/feature-flags (fase posterior, ADR-0007)
prefect/ (Python)                     tests/e2e
infra/terraform/{bootstrap,global,live,modules}   infra/k8s/{base,components,overlays}   infra/local/floci
.github/workflows                     docs/{architecture,adr}   scripts/
```

Los nombres de despliegue y de logs (`service`) conservan el nombre completo de la especificación, p. ej. `station-reservation-service`. Solo el directorio es más corto.

## Índice de ADR

| ADR | Título | Estado |
| --- | --- | --- |
| [0001](../adr/0001-floci-emulador-aws-local.md) | Floci como emulador AWS local | Aceptado |
| [0002](../adr/0002-bounded-contexts-y-orquestador-dedicado.md) | Bounded contexts y orquestador dedicado | Aceptado |
| [0003](../adr/0003-saga-orquestada-maquina-estados-persistente.md) | SAGA orquestada con máquina de estados persistente | Aceptado |
| [0004](../adr/0004-comunicacion-sincrona-http-contratos-openapi.md) | Comunicación síncrona HTTP con contratos OpenAPI | Aceptado |
| [0005](../adr/0005-idempotencia-ids-pregenerados-y-tombstones.md) | Idempotencia con IDs pre-generados y tombstones | Aceptado |
| [0006](../adr/0006-dynamodb-single-table-por-servicio.md) | DynamoDB single-table por servicio | Aceptado |
| [0007](../adr/0007-feature-flags-dynamodb-por-ambiente.md) | Feature flags en DynamoDB por ambiente | Aceptado |
| [0008](../adr/0008-autenticacion-cognito-autorizacion-por-grupos.md) | Autenticación Cognito y autorización por grupos | Aceptado |
| [0009](../adr/0009-propagacion-correlation-id-y-saga-id.md) | Propagación de correlation_id y saga_id | Aceptado |
| [0010](../adr/0010-red-apigw-vpc-link-nlb-y-vpce.md) | Red: API Gateway + VPC Link + NLB y VPCE | Aceptado |
| [0011](../adr/0011-terraform-workspaces-backend-s3-bootstrap.md) | Terraform: workspaces, backend S3 y bootstrap | Aceptado |
| [0012](../adr/0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md) | EKS por ambiente, Kustomize y acceso a Floci | Aceptado |
| [0013](../adr/0013-canary-argo-rollouts-analisis-cloudwatch.md) | Canary con Argo Rollouts y análisis en CloudWatch | Aceptado |
| [0014](../adr/0014-observabilidad-cloudwatch-fluent-bit-prefect.md) | Observabilidad: CloudWatch, Fluent Bit y Prefect | Aceptado |
| [0015](../adr/0015-cicd-github-actions-hibrido-y-promocion.md) | CI/CD híbrido y promoción entre ramas | Propuesto (P-21, P-22) |
| [0016](../adr/0016-estrategia-de-pruebas.md) | Estrategia de pruebas | Aceptado |
| [0017](../adr/0017-frontend-spa-mismo-origen-polling.md) | Frontend SPA, mismo origen y polling | Aceptado |
| [0018](../adr/0018-toolchain-monorepo-pnpm-node-typescript.md) | Toolchain del monorepo: pnpm, Node 26, TypeScript 6 y calidad | Aceptado |
| [0019](../adr/0019-paquetes-transversales-logger-config-contracts.md) | Paquetes transversales: logger (pino), config (zod) y contracts | Aceptado |
| [0020](../adr/0020-modelos-de-dominio-y-contratos-zod.md) | Modelos de dominio por bounded context y contratos con Zod | Aceptado |

Las elecciones de librerías (servidor GraphQL, validación, runner de pruebas, versión exacta de Node.js LTS) se registrarán en ADR adicionales cuando se implemente cada componente, después de verificar las versiones disponibles.
