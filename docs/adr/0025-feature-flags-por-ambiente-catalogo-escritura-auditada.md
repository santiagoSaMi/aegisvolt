# ADR-0025: Feature flags por ambiente — catálogo único, ambiente del despliegue, escritura autorizada y auditada

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Relación:** implementa y concreta ADR-0007 (flags en DynamoDB por ambiente) y ADR-0008 (autorización por grupos).

## Contexto

La fase pide un sistema de flags respaldado por DynamoDB y aislado por ambiente, con:
- `GetFeatureFlags` y `UpdateFeatureFlag`;
- cambios sin redesplegar;
- ningún cliente capaz de elegir otro ambiente, que debe salir de la configuración del despliegue;
- caché con TTL e invalidación;
- auditoría y escritura solo administrativa;
- defaults seguros;
- ningún secreto en las flags.

Hasta ahora solo energy-dispatch leía la tabla. station-reservation y billing-wallet leían sus flags de variables de entorno, así que un cambio exigía reiniciar.

**Valores iniciales:**
- La especificación (§2.2) solo fija `ENABLE_DYNAMIC_SURGE_PRICING`: `true` en dev y test, `false` en prod.
- Los de `SIMULATE_CHARGER_HARDWARE_FAULT` (dev `false`, test `true`, prod `false`) vienen de la fase. Sustituyen a los de `03-feature-flags` (todo `false`).
- La especificación no define el efecto de `ENABLE_FAST_CHARGE_BOOST`.

## Decisión

### Catálogo único (`packages/feature-flags/src/catalog.ts`)
Para cada flag guarda la descripción, el servicio que la evalúa, el valor seguro y el valor inicial por ambiente. Lo usan la siembra local, el graphql-api (lectura completa y validación de claves) y las pruebas. Terraform sembrará los mismos valores.

| Flag | `dev` | `test` | `prod` | Origen |
| --- | --- | --- | --- | --- |
| `ENABLE_DYNAMIC_SURGE_PRICING` | `true` | `true` | `false` | Especificación §2.2 |
| `SIMULATE_CHARGER_HARDWARE_FAULT` | `false` | `true` | `false` | Fase de feature flags (demostración de §6.3 en `test`) |
| `ENABLE_FAST_CHARGE_BOOST` | `true` | `false` | `false` | Propuesta (abajo) |

**`ENABLE_FAST_CHARGE_BOOST`: comportamiento propuesto antes de activarlo.**
- Es la interpretación P-14, ya documentada en `03` e implementada en `ReservationPolicy`.
- Con la flag activa, una reserva con `fastChargeBoost=true` puede tomar conectores ultra rápidos (≥ 150 kW) y obtiene un *hold* de 300 s en lugar de 120 s.
- Con la flag apagada, `fastChargeBoost=true` responde `403 FAST_CHARGE_BOOST_DISABLED`. Un conector ultra rápido sin boost responde `409`.
- No cambia precios ni cobros.
- **Solo se activa en `dev`**, donde se valida. En `test` y `prod` empieza en `false` hasta que se acepte la interpretación; activarla será un cambio operativo auditado, sin redesplegar.

**Valor seguro (`safeDefault`):** siempre `false`. Es el valor que no altera el comportamiento base: sin recargo, sin capacidades extra, sin fallos inducidos.

### Aislamiento y ambiente confiable
- **Una tabla por ambiente:** `aegisvolt-feature-flags-<env>`. El ambiente no es un atributo de la flag.
- `resolveFeatureFlagsTable(APP_ENV, FEATURE_FLAGS_TABLE_NAME?)` decide la tabla de cada proceso. `APP_ENV` lo inyecta el despliegue (overlay de Kubernetes).
  - En `dev`/`test`/`prod`, la tabla es siempre la del propio ambiente; un override distinto impide arrancar.
  - En `local` se admiten tablas temporales con el prefijo, para pruebas en Floci.
- Lo usan los cuatro procesos: graphql-api, station-reservation, billing-wallet y energy-dispatch.
- **Ninguna operación recibe el ambiente:**
  - `GetFeatureFlags` responde con el ambiente del despliegue;
  - la petición de cambio es `z.strictObject({enabled, expectedVersion?})`, así que un campo `environment` → `400`;
  - el repositorio está ligado a una sola tabla desde la composición.
- En AWS, IAM restringe además cada pod a la tabla de su ambiente (fase de IaC). Floci no evalúa IAM ([L-08](../limitations.md)).

### Lectura: `GetFeatureFlags`
- Exige identidad verificada de la plataforma (`fleet-operators` o `platform-admins`).
- Devuelve las tres flags del catálogo, cada una con su `source`:
  - `STORE`: valor de la tabla;
  - `LAST_KNOWN`: la tabla falló y se usa el último valor leído;
  - `DEFAULT`: valor seguro, si la tabla falló sin valor conocido o la flag no está sembrada.
- Si algún valor no viene de la tabla, la respuesta lleva `degraded: true`. Nunca se inventa un `true`.

### Escritura: `UpdateFeatureFlag`
- **Autorización** en la capa de aplicación (`flagsPolicy`), no en los resolvers:
  - sin identidad → `UNAUTHORIZED`;
  - sin `platform-admins` → `FORBIDDEN`.

  El `Principal` lo construirá la presentación a partir del JWT de Cognito ya verificado (fase GraphQL).
- **Validación:** clave con formato válido y presente en el catálogo (`FEATURE_FLAG_NOT_FOUND`). No crea flags no sembradas.
- **Solo booleanos:** el valor no admite texto libre, así que no puede contener secretos. La descripción sale del catálogo, nunca del cliente.
- **Concurrencia:**
  - la flag se escribe con `version = :leída`;
  - si llega `expectedVersion` y no coincide → `409 FEATURE_FLAG_VERSION_CONFLICT`;
  - sin `expectedVersion`, se relee y reintenta.

  Fijar el valor que ya tiene no escribe nada.
- **Auditoría en la misma transacción:** ítem `FLAG#<key>` / `AUDIT#<ts>#<versión>` con `from`, `to`, `version`, `changedBy` (`sub`), `changedAt`, `correlationId` y `environment`. No hay cambio sin registro. `ListFeatureFlagChanges` (solo administradores) la consulta.
- **CLI de operador local:** `scripts/flags/set.sh <env> …` ejecuta el mismo caso de uso, con autorización, versión y auditoría. Solo funciona contra Floci en `localhost`. Sustituye al script anterior de `packages/feature-flags`, que escribía directamente.

### Caché y actualización
- **Servicios** (`CachedFeatureFlagReader`):
  - TTL de 5 s (`FEATURE_FLAGS_CACHE_TTL_MS`);
  - una sola lectura compartida por flag;
  - ante un fallo, último valor conocido o `false`, sin reintentar hasta que venza el TTL;
  - nuevo `invalidate()`.
- **graphql-api** (`FlagSnapshotCache`): TTL de 5 s. El proceso que escribe **invalida** su caché al confirmar el cambio y ve el nuevo valor de inmediato.
- Las demás réplicas y servicios lo ven al vencer su TTL: como mucho 5 s, sin redesplegar.
- **Migración:** station-reservation y billing-wallet leen ahora la tabla con este lector. `StaticFeatureFlagReader` pasa a ser un doble de prueba.

## Alternativas

1. **Un parámetro `environment` en la API protegido por rol.** Rompe el requisito 3 y abre una vía de lectura o escritura entre ambientes desde el borde.
2. **Invalidación activa** (DynamoDB Streams o SNS hacia cada réplica). Baja la latencia de 5 s a menos de 1 s, pero añade infraestructura y un canal más por servicio. Un TTL de 5 s cumple §6.4 ("sin redesplegar") y es fácil de explicar.
3. **Flags con valores no booleanos** (porcentajes, listas). No hacen falta, y el texto libre abriría la puerta a guardar secretos o configuración sensible.
4. **AWS AppConfig, Unleash o Flagsmith** (ADR-0007).

## Consecuencias

- **Positivas:** demostrado contra Floci:
  - en la prueba de integración, con tres tablas, un cambio en `dev` deja `test` y `prod` intactos (mismos ítems, sin auditoría);
  - en el [runbook](../runbooks/feature-flags-demo.md), dos procesos reales de billing-wallet (`dev` y `prod`) con el recargo en hora pico: `dev` deja de aplicarlo en ≤ 2 s sin reiniciar y `prod` no cambia;
  - un `dev` configurado contra la tabla de `prod` no arranca.
- **Negativas:**
  - Hasta 5 s de inconsistencia entre réplicas tras un cambio.
  - Los valores iniciales viven en el catálogo y en `tfvars`; la fase de IaC debe generarlos desde el catálogo o verificar que coinciden.
  - Con `SIMULATE_CHARGER_HARDWARE_FAULT=true` en `test`, toda SAGA de `test` se compensa hasta que se apague la flag. Es intencionado, para la demostración.
  - La exposición GraphQL (query `featureFlags`, mutación `setFeatureFlag`) y la verificación del JWT llegan en la fase del GraphQL API; los casos de uso ya están listos para recibir el `Principal`.
