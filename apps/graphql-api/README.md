# graphql-api

BFF GraphQL de AegisVolt: el punto de entrada único (§2.2) con **Apollo Server 5** sobre Express 5. Es el único escritor de la tabla de feature flags del ambiente y no tiene más persistencia: el resto de datos los obtiene por HTTP del servicio dueño. Decisiones: [ADR-0026](../../docs/adr/0026-graphql-api-apollo-bff-autenticacion-resiliencia.md) y [ADR-0025](../../docs/adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md). **Guía de uso con ejemplos:** [docs/graphql](../../docs/graphql/README.md).

## Operaciones

| Tipo | Campo | Caso de uso | Servicio |
| --- | --- | --- | --- |
| Query | `stations`, `stationById`, `availableConnectors` | `CatalogQueries` | station-reservation |
| Query | `walletBalance`, `transactions` | `FleetQueries` (flota del token) | billing-wallet |
| Query | `reservations` | `FleetQueries` | station-reservation (`GET /v1/reservations?fleetId=`) |
| Query | `chargingSessions`, `chargingSessionById` (+ `telemetry`) | `CatalogQueries` | energy-dispatch |
| Query | `sagaStatus` (+ `events`) | `FleetQueries` | saga-orchestrator |
| Query | `featureFlags` | `GetFeatureFlags` | tabla de flags propia |
| Mutation | `reserveAndActivateCharging` | `ReserveAndActivateCharging` → `POST /v1/sagas` | saga-orchestrator |
| Mutation | `releaseReservation` | `ReleaseReservation` (reglas frente a la SAGA) | station, orchestrator, dispatch |
| Mutation | `stopChargingSession` | `StopChargingSession` (parada + liberación) | dispatch, orchestrator, station |
| Mutation | `updateFeatureFlag` | `UpdateFeatureFlag` (solo `platform-admins`) | tabla de flags propia |

## Estructura

```text
src/
  domain/          FeatureFlag (Platform Configuration)
  application/     casos de uso del BFF y de flags · fleetPolicy / flagsPolicy (autorización)
                   puertos: Upstreams (vistas de los contratos), TokenVerifier, FeatureFlagRepository
  infrastructure/  ServiceClient (timeouts, reintentos selectivos, correlation id) y gateways HTTP,
                   CognitoTokenVerifier (jose + JWKS), repositorio de flags, readiness
  presentation/    graphql/: schema.ts (SDL documentado), resolvers delgados, validación Zod,
                   errores centralizados, límite de profundidad · http/: Express, probes, apagado
  config.ts · composition.ts · main.ts
scripts/set-flag.ts   CLI local de operador (Floci) para flags
```

## Ejecutar y probar

```bash
cp apps/graphql-api/.env.example apps/graphql-api/.env    # completar Cognito (ver la guía)
pnpm --filter @aegisvolt/graphql-api dev                 # http://localhost:4000/graphql
pnpm --filter @aegisvolt/graphql-api test                # esquema, resolvers, aplicación, HTTP, cliente, JWT
REQUIRE_INTEGRATION=true pnpm --filter @aegisvolt/graphql-api test:integration   # flags en Floci
REQUIRE_INTEGRATION=true pnpm test:e2e                   # flujo completo: Cognito + 5 procesos + Floci
```

| Suite | Casos clave |
| --- | --- |
| `test/presentation/schema` | Operaciones requeridas, un resolver por campo, documentación, enums alineados con los contratos, ningún argumento de ambiente |
| `test/presentation/graphql` | Cada query y mutación; `UNAUTHENTICATED`/`FORBIDDEN`; validación y límites (incluida la profundidad); reglas de `releaseReservation`; errores sin detalles internos y con `correlationId` |
| `test/presentation/http` | Token válido o inválido (sin registrarlo), `correlation_id` creado o propagado, CSRF, límite de cuerpo, probes |
| `test/infrastructure` | Reintentos selectivos (idempotente y transitorio), timeouts, contrato de respuesta; JWT (`iss`/`aud`/`exp`/`token_use`/firma) |
| `test/application` + `test/integration` | Feature flags (ADR-0025) |
| `tests/e2e/test/graphql.e2e.test.ts` | Tokens reales de Cognito en Floci; SAGA completada y compensada por GraphQL; parada y liberación; autorización; `correlation_id` en los cinco procesos |

## Limitaciones

- Las suscripciones (WebSocket) quedan fuera: el frontend usa polling (ADR-0017).
- No hay *circuit breaker* ni DataLoader (justificado en ADR-0026).
- El Dockerfile y el despliegue llegan en la fase de Kubernetes.
