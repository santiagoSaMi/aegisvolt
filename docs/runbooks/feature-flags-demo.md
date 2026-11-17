# Runbook · Feature flags aisladas por ambiente (Floci)

Demuestra §6.4 de la especificación: cambiar una flag en `dev` sin redesplegar y comprobar que `test` y `prod` no cambian. Diseño: [ADR-0025](../adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md) y [03-feature-flags-y-seguridad.md](../architecture/03-feature-flags-y-seguridad.md).

Solo contra Floci en `localhost` y con credenciales ficticias (`test`/`test`). Los scripts rechazan cualquier otro endpoint.

## 1. Prueba automática

```bash
scripts/floci/start.sh
REQUIRE_INTEGRATION=true pnpm --filter @aegisvolt/graphql-api test:integration
```

[`feature-flags-isolation.int.test.ts`](../../apps/graphql-api/test/integration/feature-flags-isolation.int.test.ts):
1. Crea tres tablas (una por ambiente), sembradas con los valores del catálogo.
2. Usa un "despliegue" del graphql-api por ambiente y el lector con caché de los servicios.
3. Verifica que:
   - cada ambiente arranca con sus valores;
   - un administrador cambia dos flags en `dev`, con versión 2 y auditoría (`changedBy`, `correlationId`, `environment: dev`);
   - los ítems de `test` y `prod` son **idénticos** a los de antes (misma versión) y **sin auditoría**;
   - los lectores de los servicios de `dev` ven el cambio al refrescar su caché y los de `test`/`prod` no;
   - un operador no puede escribir y no queda nada escrito;
   - dos administradores con la misma `expectedVersion`: uno gana y el otro recibe `409`;
   - un `dev` no puede configurarse contra la tabla de `prod`.

## 2. Demostración en vivo con un servicio real (ejecutada el 2026-11-13)

Se levantan dos procesos reales de billing-wallet: uno como despliegue de `dev` y otro como despliegue de `prod`. Cada uno lee **su** tabla de flags (`APP_ENV`), con caché de 2 s para la demo (5 s por defecto). El recargo dinámico solo aplica en la ventana pico (17:00–21:00, hora de Bogotá).

```bash
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
for e in dev test prod; do pnpm --filter @aegisvolt/feature-flags flags:create-local-table $e; done

cd services/billing-wallet
for e in dev prod; do DYNAMODB_TABLE_NAME=aegisvolt-billing-demo-$e node scripts/create-local-table.ts; done
APP_ENV=dev  PORT=24202 DYNAMODB_TABLE_NAME=aegisvolt-billing-demo-dev  FEATURE_FLAGS_CACHE_TTL_MS=2000 node src/main.ts &
APP_ENV=prod PORT=24203 DYNAMODB_TABLE_NAME=aegisvolt-billing-demo-prod FEATURE_FLAGS_CACHE_TTL_MS=2000 node src/main.ts &
# abrir y recargar la billetera fleet_demo en ambos (PUT /v1/wallets/… y …/top-ups/tup_<uuid>)
curl "localhost:24202/v1/wallets/fleet_demo/funds-check?energyKwh=30&connectorPowerKw=60"
scripts/flags/set.sh dev ENABLE_DYNAMIC_SURGE_PRICING false     # desde la raíz del repo
```

Resultado obtenido a las 17:45, hora local:

```text
## Antes
  billing dev : required=3750000 surgeApplied=true  multiplierBP=12500
  billing prod: required=3000000 surgeApplied=false multiplierBP=10000
## Cambio: scripts/flags/set.sh dev ENABLE_DYNAMIC_SURGE_PRICING false
aegisvolt-feature-flags-dev: ENABLE_DYNAMIC_SURGE_PRICING = false (v2, auditado)
## Después de ≤ TTL (2 s), MISMOS procesos (sin reinicio ni redespliegue)
  billing dev : required=3000000 surgeApplied=false multiplierBP=10000
  billing prod: required=3000000 surgeApplied=false multiplierBP=10000
## Un despliegue de dev apuntando a la tabla de prod no arranca:
FEATURE_FLAGS_TABLE_NAME (en dev la tabla de flags debe ser aegisvolt-feature-flags-dev
                          (se recibió aegisvolt-feature-flags-prod))  →  "Arranque fallido", exit=1
```

Ítems de DynamoDB tras el cambio (`aws --endpoint-url http://localhost:4566 dynamodb get-item / query`):

```text
## FLAG#ENABLE_DYNAMIC_SURGE_PRICING / META en cada tabla
  dev   {"enabled":false,"version":"2","updatedBy":"cli:<usuario>","updatedAt":"2026-11-13T22:45:22.395Z"}
  test  {"enabled":true, "version":"1","updatedBy":"seed","updatedAt":"2026-11-13T22:44:57.119Z"}
  prod  {"enabled":false,"version":"1","updatedBy":"seed","updatedAt":"2026-11-13T22:44:57.568Z"}
## FLAG#ENABLE_DYNAMIC_SURGE_PRICING / AUDIT#… en cada tabla
  dev   [{"from":true,"to":false,"version":"2","changedBy":"cli:<usuario>","changedAt":"2026-11-13T22:45:22.395Z",
          "environment":"dev","correlationId":"fce9281f-aac2-4992-a9ca-97b9fcb15b89"}]
  test  []
  prod  []
```

Concurrencia optimista desde la CLI:

```text
$ scripts/flags/set.sh dev ENABLE_DYNAMIC_SURGE_PRICING true --expected-version 2
aegisvolt-feature-flags-dev: ENABLE_DYNAMIC_SURGE_PRICING = true (v3, auditado)
$ scripts/flags/set.sh dev ENABLE_DYNAMIC_SURGE_PRICING true --expected-version 1
FeatureFlagVersionConflictError: La flag ENABLE_DYNAMIC_SURGE_PRICING está en la versión 3, no en 1
```

## 3. Consultas útiles

```bash
aws --endpoint-url http://localhost:4566 dynamodb get-item --table-name aegisvolt-feature-flags-test \
  --key '{"PK":{"S":"FLAG#SIMULATE_CHARGER_HARDWARE_FAULT"},"SK":{"S":"META"}}'
aws --endpoint-url http://localhost:4566 dynamodb query --table-name aegisvolt-feature-flags-dev \
  --key-condition-expression 'PK = :pk AND begins_with(SK, :a)' \
  --expression-attribute-values '{":pk":{"S":"FLAG#ENABLE_DYNAMIC_SURGE_PRICING"},":a":{"S":"AUDIT#"}}'
```

En el frontend (fase posterior), la query `featureFlags` de `dev` mostrará el cambio en ≤ 5 s y la de `prod` seguirá igual.
