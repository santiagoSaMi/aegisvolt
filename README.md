# AegisVolt

Plataforma cloud-native para la gestión de carga de flotas de vehículos eléctricos. La especificación está en [`proyecto_final.md`](proyecto_final.md) y las reglas de trabajo en [`CLAUDE.md`](CLAUDE.md).

## Estado

| Fase | Estado |
| --- | --- |
| Entorno local AWS con Floci | Listo. Ver [`infra/local/floci/README.md`](infra/local/floci/README.md) |
| Diseño de arquitectura | Documentado en [`docs/architecture/`](docs/architecture/README.md), ADR 0002–0017; decisiones pendientes en [09](docs/architecture/09-analisis-especificacion.md) |
| Estructura del monorepo | Lista ([ADR-0018](docs/adr/0018-toolchain-monorepo-pnpm-node-typescript.md), [ADR-0019](docs/adr/0019-paquetes-transversales-logger-config-contracts.md)) |
| Modelos de dominio y contratos | Listos ([ADR-0020](docs/adr/0020-modelos-de-dominio-y-contratos-zod.md), [docs/contracts](docs/contracts/README.md)) |
| station-reservation-service | Implementado con Express, DynamoDB y pruebas de integración en Floci ([README](services/station-reservation/README.md), [ADR-0021](docs/adr/0021-station-reservation-concurrencia-idempotencia-expiracion.md)) |
| billing-wallet-service | Implementado con libro mayor atómico, reembolsos como operación propia y pruebas de integración en Floci ([README](services/billing-wallet/README.md), [ADR-0022](docs/adr/0022-billing-wallet-ledger-atomico-y-compensaciones.md)) |
| graphql-api (BFF) | Apollo Server 5 sobre Express: 10 queries y 4 mutaciones, JWT de Cognito, políticas por flota y rol, errores centralizados, llamadas internas con timeouts y reintentos selectivos; flujo completo verificado contra Floci ([guía](docs/graphql/README.md), [ADR-0026](docs/adr/0026-graphql-api-apollo-bff-autenticacion-resiliencia.md)) |
| Feature flags por ambiente | Tabla por ambiente derivada de `APP_ENV`; `GetFeatureFlags` y `UpdateFeatureFlag` (solo administradores, versión condicional y auditoría) en el graphql-api; los tres servicios leen sin redesplegar ([ADR-0025](docs/adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md), [runbook](docs/runbooks/feature-flags-demo.md)) |
| saga-orchestrator-service | SAGA `ReserveAndActivateCharging` orquestada, con persistencia antes y después de cada paso, lease, compensaciones verificadas y recuperación; E2E con los cuatro servicios reales en Floci ([README](services/saga-orchestrator/README.md), [ADR-0024](docs/adr/0024-saga-orquestada-implementacion-estados-lease-recuperacion.md), [runbook](docs/runbooks/saga-demo.md)) |
| Consola web (`apps/web`) | React 19 + Apollo Client 4: dashboard, estaciones, carga con progreso de la SAGA, transacciones, flags y observabilidad; login con Cognito, ambiente del despliegue y polling configurable; E2E en Chromium real contra Floci ([README](apps/web/README.md), [ADR-0027](docs/adr/0027-consola-web-react-apollo-auth-config-runtime.md), [runbook](docs/runbooks/web-console-demo.md)) |
| Observabilidad · A. Logging | JSON estructurado en los cinco procesos con `timestamp`, `level`, `environment`, `service_name`, `correlation_id`, `saga_id`, `operation`, `message` y `error` tipado; `correlation_id` por cabeceras HTTP; redacción de secretos y datos personales; traza de una SAGA fallida verificada en E2E ([ADR-0028](docs/adr/0028-logging-estructurado-operation-errores-tipados.md)) |
| Observabilidad · B. CloudWatch | Fluent Bit 5.1.5 (DaemonSet) → `/aegisvolt/<env>/<servicio>`; log groups, metric filters (SAGA completadas, compensadas, fallidas, duración; errores y 5xx por servicio), alarmas y dashboard en Terraform (workspaces `dev`/`test`/`prod`); operaciones de CloudWatch en Floci 2.4.0 verificadas y recolección probada de punta a punta en el EKS de Floci ([ADR-0029](docs/adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md), [runbook](docs/runbooks/cloudwatch-demo.md)) |
| Observabilidad · C. Prefect | Proyecto Python independiente (`prefect/`, Prefect 3.9.0): `environment_health_monitor` y auditorías de SAGA, reservas y billing con reglas puras citadas en cada hallazgo; solo lectura por las APIs (nuevo `GET /v1/audit/sagas` en el orquestador); 25 pruebas con fixtures; verificado contra el stack real con dashboard ([README](prefect/README.md), [ADR-0030](docs/adr/0030-prefect-auditoria-solo-lectura-por-apis.md)) |
| Contenedores y Kubernetes | Seis imágenes (multi-stage, base fijada por digest, no root, etiqueta `sha-<commit>`); docker compose integrado con Floci; Kustomize base + overlays `dev`/`test`/`prod` con probes, security contexts, ServiceAccounts y NetworkPolicies; desplegado y operado en el EKS (k3s) de Floci con SAGA real y logs en CloudWatch ([ADR-0031](docs/adr/0031-contenedores-kubernetes-floci.md), [runbook](docs/runbooks/k8s-floci.md)) |
| Infraestructura como código | Terraform 1.17.1 + provider AWS 6.71.0: `bootstrap` (bucket de estado versionado, cifrado, privado; estado migrado a S3), `global` (ECR) y `live` con workspaces `dev`/`test`/`prod` y módulos `network`, `dynamodb-table`, `iam` (Pod Identity), `eks`, `api-gateway`, `cloudwatch` y `ecr`; bloqueo nativo `use_lockfile`; destino Floci aislado (sin `~/.aws`, endpoints y cuenta validados); recursos previos adoptados sin pérdida; evidencias de separación de estados, versiones y lock ([ADR-0033](docs/adr/0033-terraform-modular-backend-s3-floci.md), [runbook](docs/runbooks/terraform-floci.md)) |
| Canary deployment | graphql-api con Argo Rollouts v1.10.1 y reparto por peso en Traefik v3.7.16 (80/20 → 50/50 → 100 %); `AnalysisTemplate` con disponibilidad (≥ 11/12 sondeos) y tasa de error ≤ 2 % con ≥ 30 operaciones, leída del CloudWatch de Floci por el proveedor nativo de Argo; promoción, rollback inducido y pausa por muestra insuficiente demostrados con tráfico medido por respuesta ([ADR-0032](docs/adr/0032-canary-argo-rollouts-traefik-cloudwatch.md), [runbook](docs/runbooks/canary-demo.md)) |
| energy-dispatch-service | Implementado con puerto `ChargerAdapter`, cargador simulado, falla inducida por flag desde la tabla de flags del ambiente, telemetría y pruebas de integración en Floci ([README](services/energy-dispatch/README.md), [ADR-0023](docs/adr/0023-energy-dispatch-cargador-simulado-flags-y-telemetria.md)) |

## Requisitos

| Herramienta | Versión | Instalación |
| --- | --- | --- |
| Node.js | 26 LTS (fijada en `.nvmrc`) | `nvm install && nvm use` en la raíz del repo |
| pnpm | 12.18.0 (`packageManager`) | `npm install -g pnpm@12.18.0`. Node 26 ya no incluye corepack |
| Docker, AWS CLI, Terraform, kubectl, jq | ver [Floci](infra/local/floci/README.md#requisitos) | Solo para infraestructura local |

`pnpm-workspace.yaml` tiene `engineStrict: true`: la instalación falla con una versión de Node distinta de la 26.

## Primeros pasos

```bash
nvm use                       # Node 26
pnpm install                  # instala todo el workspace (lockfile incluido)
pnpm check                    # formato + lint + typecheck + pruebas + build (lo mismo que verificará CI)
```

## Comandos raíz

| Comando | Qué hace |
| --- | --- |
| `pnpm build` | Compila todos los paquetes en orden topológico (`tsc` en Node, `vite build` en la web) |
| `pnpm typecheck` | Compila `packages/*` y ejecuta `tsc --noEmit` en cada proyecto |
| `pnpm test` | Ejecuta las pruebas de todos los proyectos con Vitest (sin dependencias externas) |
| `pnpm test:integration` | Pruebas de integración contra Floci (`scripts/floci/start.sh` antes). Se omiten si Floci no responde, salvo con `REQUIRE_INTEGRATION=true` |
| `pnpm test:e2e` | E2E de la SAGA: levanta los cuatro servicios contra Floci y guarda la evidencia de DynamoDB en `tests/e2e/.evidence/` |
| `pnpm lint` | ESLint con reglas de tipos (`--max-warnings=0`) + dependency-cruiser (ciclos, capas y límites entre servicios) |
| `pnpm lint:code` / `pnpm lint:deps` | Cada una de las dos partes de `lint` por separado |
| `pnpm format` / `pnpm format:check` | Aplica o verifica Prettier (el Markdown queda excluido para preservar la documentación) |
| `pnpm check` | Todo lo anterior en secuencia |
| `pnpm dev` | Arranca en paralelo todas las apps y servicios en modo desarrollo |
| `pnpm clean` | Elimina `dist/` y `coverage/` |

## Trabajar con una sola unidad

```bash
pnpm --filter @aegisvolt/billing-wallet-service test
pnpm --filter @aegisvolt/billing-wallet-service dev         # Node 26 ejecuta src/main.ts directamente (--watch)
pnpm --filter @aegisvolt/web dev                             # Vite en http://localhost:5173 (proxy /graphql → :4000, /auth/cognito → Floci)
pnpm --filter "./services/**" build                          # solo los microservicios

# Paquete desplegable aislado (solo dist + dependencias de producción), base de la imagen Docker
pnpm --filter @aegisvolt/billing-wallet-service deploy --prod /tmp/billing-wallet
```

Cada app o servicio tiene un `.env.example`. Para usarlo, cópialo a `.env` (ignorado por Git). Los valores son ficticios y solo locales.

Si modificas un paquete de `packages/*` y lo consume una app en modo `dev`, recompílalo con `pnpm build:packages`.

## Estructura

| Ruta | Paquete | Puerto | Responsabilidad |
| --- | --- | --- | --- |
| `apps/web` | `@aegisvolt/web` | 5173 | SPA React (ADR-0017) |
| `apps/graphql-api` | `@aegisvolt/graphql-api` | 4000 | BFF GraphQL ([README](apps/graphql-api/README.md), [guía](docs/graphql/README.md)) |
| `services/saga-orchestrator` | `@aegisvolt/saga-orchestrator-service` | 4100 | Orquestador de la SAGA (ADR-0002) |
| `services/station-reservation` | `@aegisvolt/station-reservation-service` | 4101 | Reservas de conectores |
| `services/billing-wallet` | `@aegisvolt/billing-wallet-service` | 4102 | Billeteras y cobros |
| `services/energy-dispatch` | `@aegisvolt/energy-dispatch-service` | 4103 | Activación del cargador y telemetría |
| `packages/contracts` | `@aegisvolt/contracts` | — | Cabeceras HTTP, `problem+json`, OpenAPI |
| `packages/logger` | `@aegisvolt/logger` | — | Logger JSON con `correlation_id`/`saga_id` |
| `packages/config` | `@aegisvolt/config` | — | Configuración validada por entorno |
| `packages/feature-flags` | `@aegisvolt/feature-flags` | — | Catálogo de flags, tabla por ambiente y lector DynamoDB con caché (ADR-0007, ADR-0025) |
| `prefect/` | — | — | Flujos de observabilidad (Python, fase posterior) |
| `tests/e2e/` | `@aegisvolt/e2e-tests` | — | E2E con los cinco procesos reales y Cognito contra Floci (SAGA y GraphQL) |
| `infra/` | — | — | Floci local, Terraform y Kubernetes |
| `scripts/` | — | — | Scripts operativos (Floci, `flags/set.sh` para flags locales) |
| `.github/workflows/` | — | — | CI/CD (fase posterior) |

**Estructura interna de cada servicio** (hexagonal; dependency-cruiser la hace cumplir):

```text
src/
  domain/          # sin dependencias externas ni de otras capas
  application/     # casos de uso y puertos; no conoce adaptadores
  infrastructure/  # adaptadores de salida (DynamoDB, HTTP clients…)
  presentation/    # adaptadores de entrada (HTTP)
  config.ts        # configuración validada
  main.ts          # composition root
test/
```

Ningún servicio importa código de otro: se comunican por HTTP con los contratos de `packages/contracts`.

## Entorno local (Floci)

```bash
scripts/floci/start.sh                 # inicia Floci 2.4.0 en http://localhost:4566 (persistente)
scripts/floci/smoke-test.sh            # verifica S3, DynamoDB, Logs, API Gateway, VPC/VPCE, ECR
scripts/floci/smoke-test.sh --with-eks # + EKS (k3s)
scripts/floci/terraform-check.sh       # verifica Terraform (provider + backend S3) contra Floci
scripts/floci/stop.sh                  # detiene sin borrar datos
```

Todo el desarrollo apunta a Floci con credenciales ficticias. **Nunca** se aprovisiona en una cuenta AWS real.

## Documentación

- [Arquitectura](docs/architecture/README.md)
- [ADR](docs/adr/)
- [Limitaciones conocidas del entorno local](docs/limitations.md)
