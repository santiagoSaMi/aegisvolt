# @aegisvolt/web — Consola de flotas

Consola B2B (React 19 + Vite 8 + TypeScript) para operar la carga de flotas eléctricas. Consume **únicamente** el endpoint GraphQL de su ambiente. Decisiones: [ADR-0017](../../docs/adr/0017-frontend-spa-mismo-origen-polling.md) y [ADR-0027](../../docs/adr/0027-consola-web-react-apollo-auth-config-runtime.md).

## Secciones

| Ruta | Sección | Datos (GraphQL) |
| --- | --- | --- |
| `#/dashboard` | Estaciones, conectores disponibles, reservados y ocupados, sesiones activas, salud de servicios y flags | `systemStatus`, `stations`, `chargingSessions`, `featureFlags` |
| `#/stations` (`/:id`) | Estaciones, conectores, disponibilidad, sesiones activas y última telemetría | `stations`, `stationById`, `chargingSessions { telemetry }` |
| `#/charging` | Flota, estación, conector, energía, monto estimado, inicio y progreso o resultado de la SAGA | `availableConnectors`, `chargingEstimate`, `reserveAndActivateCharging`, `sagaStatus` |
| `#/transactions` | Saldo, débitos, reembolsos y recargas (paginados y filtrables), errores y compensaciones | `walletBalance`, `transactions`, `sagas` |
| `#/feature-flags` | Flags del ambiente, origen, versión y último cambio; edición con confirmación (solo administradores) | `featureFlags`, `updateFeatureFlag` |
| `#/observability` | Historial de SAGAs por estado, búsqueda por `sagaId` o `correlation_id`, eventos, compensaciones y fallos | `sagas`, `sagaStatus { events }` |

## Estructura

```
src/
  app/            App (providers + rutas con carga diferida), AppShell, EnvironmentIndicator
  features/<f>/   api.ts (TypedDocumentNode + hooks de datos) · model.ts (tipos y funciones puras)
                  use*.ts (hooks de interfaz) · *Page.tsx / components.tsx (presentación)
  shared/         api/ (Apollo, errores, viewer) · auth/ (Cognito, sesión) · config/ · hooks/ · format/ · ui/
```

Reglas:

- Los componentes no contienen reglas de negocio ni llaman a Apollo directamente.
- Los importes, el saldo suficiente, la disponibilidad y el resultado de la SAGA vienen del backend.
- El cliente valida solo el formato de las entradas (Zod).

## Configuración (sin secretos)

El SPA lee `./config.json` **en tiempo de ejecución**. Lo sirve el despliegue: el ConfigMap del overlay en Kubernetes y, en desarrollo, Vite.

```json
{
  "environment": "dev",
  "graphqlUrl": "./graphql",
  "auth": { "cognitoUrl": "./auth/cognito", "clientId": "<app client público del User Pool>" },
  "pollingIntervalMs": 5000,
  "cities": ["bogota"]
}
```

- **Ambiente.** El badge muestra el ambiente que informa el backend (`viewer.environment`) y alerta si no coincide con `config.json`. No hay selector: las URLs son relativas al mismo origen, así que el navegador no puede cambiar de ambiente.
- **Polling.** `pollingIntervalMs` controla el refresco de la disponibilidad, la telemetría, la SAGA y las flags. **No hay suscripciones ni WSS.**
- **Sin secretos.** El `clientId` de un app client público no es un secreto. El ID token vive en `sessionStorage` y nunca se guarda la contraseña.

## Desarrollo local

Requisitos: Floci, los servicios y el graphql-api en marcha, y un User Pool con usuarios. El paso a paso está en el [runbook de la consola](../../docs/runbooks/web-console-demo.md).

```bash
cp .env.example .env          # DEV_COGNITO_CLIENT_ID=<client id del pool local>
pnpm --filter @aegisvolt/web dev   # http://localhost:5173
```

Vite reenvía `/graphql` al graphql-api (`:4000`) y `/auth/cognito` a Cognito en Floci (`:4566`). Además genera `/config.json` a partir de `.env`.

## Pruebas

| Comando | Qué cubre |
| --- | --- |
| `pnpm --filter @aegisvolt/web test` | 59 pruebas (Vitest + jsdom). Unitarias de modelos, auth y `config.json`. Componentes accesibles: tabla, campos, interruptor, diálogo, errores con `correlation_id`, login y ambiente. Integración de páginas con Apollo Client y `MockLink`: carga exitosa, compensada, con error y reintento con la misma clave de idempotencia; flags admin y operador, con confirmación y conflicto; observabilidad; transacciones |
| `REQUIRE_INTEGRATION=true pnpm test:e2e` | E2E en **Chromium real** (`tests/e2e/test/web.e2e.test.ts`): login inválido; flujo exitoso hasta `COMPLETED`; flujo fallido en el que el administrador activa la falla desde la UI y la carga del operador termina `COMPENSATED`, con el historial visible en Observabilidad. Las capturas quedan en `tests/e2e/.evidence/web/` |

## Pendiente

- Imagen nginx no root con CSP y proxy `/graphql` + `/auth/cognito`. Llega en la fase de contenedores, junto con los Dockerfiles de los servicios.
- Login con Hosted UI o PKCE para AWS real (ADR-0027).
