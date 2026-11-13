# graphql-api

BFF GraphQL de AegisVolt. **Estado actual:** solo está implementado el módulo de **feature flags** (único escritor de `aegisvolt-feature-flags-<env>`, ADR-0007), en arquitectura hexagonal. El servidor GraphQL, el esquema y la verificación del JWT de Cognito llegan en la fase del GraphQL API. Decisiones: [ADR-0025](../../docs/adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md).

## Casos de uso

| Caso de uso | Autorización | Comportamiento |
| --- | --- | --- |
| `GetFeatureFlags(principal)` | `fleet-operators` o `platform-admins` | Las tres flags del ambiente del despliegue, con `source` y `degraded`. Caché de 5 s; si la tabla falla, último valor conocido o valor seguro (`false`) |
| `UpdateFeatureFlag(principal, {key, enabled, expectedVersion?, correlationId})` | `platform-admins` | Solo claves del catálogo y valores booleanos; versión condicional; auditoría en la misma transacción; invalida la caché local; idempotente |
| `ListFeatureFlagChanges(principal, {key, limit})` | `platform-admins` | Auditoría de una flag, la más reciente primero |

El **ambiente** no es un parámetro: lo fija `APP_ENV` del despliegue, y la tabla se deriva de él (`resolveFeatureFlagsTable`). En `dev`, `test` y `prod`, configurar otra tabla impide arrancar.

## Estructura

```text
src/
  domain/          FeatureFlag, FeatureFlagKey, ActorId, FlagChange
  application/     GetFeatureFlags, UpdateFeatureFlag, ListFeatureFlagChanges, flagsPolicy (autorización),
                   FlagSnapshotCache, puerto FeatureFlagRepository
  infrastructure/  DynamoDbFeatureFlagRepository (TransactWrite flag + auditoría), cliente AWS
  composition.ts   casos de uso ligados a la tabla y al ambiente del despliegue
scripts/set-flag.ts  CLI de operador LOCAL (Floci): mismo caso de uso; ver scripts/flags/set.sh
```

## Pruebas

```bash
pnpm --filter @aegisvolt/graphql-api test                # dominio, autorización, caché, defaults, conflicto
REQUIRE_INTEGRATION=true pnpm --filter @aegisvolt/graphql-api test:integration   # aislamiento dev/test/prod en Floci
```
