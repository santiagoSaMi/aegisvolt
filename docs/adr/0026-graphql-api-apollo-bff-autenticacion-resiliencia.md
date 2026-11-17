# ADR-0026: graphql-api — Apollo Server como BFF, autenticación Cognito, errores y resiliencia de llamadas internas

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Relación:**
  - concreta ADR-0002 (BFF sin estado de negocio), ADR-0004 (HTTP entre servicios), ADR-0008 (Cognito y grupos), ADR-0009 (`correlation_id`), ADR-0017 (frontend por polling) y ADR-0025 (flags);
  - fija la librería GraphQL que el stack dejaba "(ADR)".

## Contexto

La especificación (§2.2) exige un esquema GraphQL unificado como punto de entrada. La fase pide:
- 10 queries y 4 mutaciones;
- resolvers delgados que delegan en casos de uso, sin DynamoDB ni lógica de SAGA;
- validación, límites y autenticación/autorización;
- errores centralizados sin secretos ni stack traces;
- `correlation_id`;
- llamadas internas con timeouts, reintentos selectivos y *circuit breaking* solo si se justifica;
- configuración por ambiente, health/readiness y pruebas de integración contra Floci.

## Decisión

### Librería y versiones (verificadas en el registro el 2026-11-13)

| Paquete | Versión | Motivo |
| --- | --- | --- |
| `@apollo/server` | 5.5.1 | Servidor GraphQL de referencia, schema-first. Se descartó la 5.5.2, publicada hace dos días |
| `@as-integrations/express5` | 1.1.2 | En Apollo 5 la integración con Express es un paquete aparte; usamos Express 5 como el resto de servicios |
| `graphql` | 16.14.2 | Apollo 5 exige `^16.11`; la 17 no es compatible |
| `jose` | 6.2.14 | Verificación de JWT y JWKS (RS256), sin dependencias nativas |

`@apollo/protobufjs` (transitiva) trae un `postinstall` que se revisó: solo crea una carpeta y emite avisos. Se **deniega** en `allowBuilds` de `pnpm-workspace.yaml`.

**Alternativas descartadas:** GraphQL Yoga y Mercurius. Son equivalentes, pero Apollo es el más documentado para la sustentación y su `executeOperation` facilita las pruebas de resolvers.

### Capas
- **Presentación:**
  - `schema.ts` (SDL documentado);
  - `resolvers.ts`: validan con Zod, delegan y adaptan la forma;
  - `errors.ts` (`formatError`), `depth-limit.ts` y el contexto (identidad).
- **Aplicación:**
  - `CatalogQueries`, `FleetQueries`, `ReserveAndActivateCharging` (invoca la SAGA del orquestador), `ReleaseReservation`, `StopChargingSession` y los casos de uso de flags;
  - políticas `fleetPolicy` y `flagsPolicy`;
  - puertos `Upstreams` (vistas de los contratos) y `TokenVerifier`.
- **Infraestructura:** `ServiceClient` y gateways HTTP, `CognitoTokenVerifier` y el repositorio de flags (la **única** tabla del graphql-api).
- **Sin persistencia compartida:** reservas, billeteras, sesiones y SAGAs se leen y escriben por la API de su servicio dueño.
  - La query `reservations` necesitaba un listado por flota que no existía. Se añadió a **station-reservation**: `GET /v1/reservations?fleetId=`, con GSI2 `FLEET#` en su propia tabla. Contrato 1.2.0.

### Autenticación y autorización
- `Authorization: Bearer <ID token de Cognito>`. `CognitoTokenVerifier` comprueba:
  - firma RS256 contra el JWKS (caché y recarga ante `kid` desconocido);
  - `iss` y `aud` (client id) del pool **del ambiente**;
  - `exp` y `token_use = id`.
- Grupos y flota salen de claims firmados (`cognito:groups`, `custom:fleet_id`). Se verificó en Floci que el ID token los incluye.
- En Floci, el `iss` usa el hostname `floci`, así que `COGNITO_ISSUER` (el valor esperado) es independiente de `COGNITO_JWKS_URL` (de dónde se descarga).
- Un token ausente o inválido deja la petición sin identidad: los casos de uso responden `UNAUTHENTICATED`. El token nunca se registra.
- **Políticas en la capa de aplicación:**
  - operadores: solo su flota, por defecto la del token;
  - administradores: cualquier flota, indicándola;
  - mutaciones administrativas (`updateFeatureFlag`): solo `platform-admins`.
- **Visibilidad:** el catálogo, los conectores y las sesiones por estación son operativos y visibles para cualquier usuario autenticado. Billetera, movimientos, reservas, SAGAs y parada o liberación están restringidos a la flota dueña.

### Reglas de las mutaciones del BFF
No interfieren con la SAGA:
- **`releaseReservation`:**
  - `CONFLICT SAGA_IN_PROGRESS` si su SAGA no es terminal;
  - `CONFLICT CHARGING_SESSION_ACTIVE` si la carga sigue activa;
  - en otro caso, `release` idempotente con la SAGA dueña.
- **`stopChargingSession`:** parada idempotente del cargador y después liberación de la reserva confirmada (el conector vuelve a `AVAILABLE`). Reintentarla es seguro.

### Validación y límites
- Ids con los esquemas de los contratos; energía de 0 a 500 kWh; `idempotencyKey` UUID; `first` entre 1 y 50; telemetría entre 1 y 100.
- Profundidad máxima del documento: 8.
- Cuerpo de 64 KB como máximo.
- Protección CSRF de Apollo activa.
- Introspección y sugerencias solo fuera de `prod`.
- Sin landing page remota ni reporte de uso a Apollo.

### Errores centralizados (`formatError`)
- Cada error lleva `extensions.code` (`UNAUTHENTICATED`, `FORBIDDEN`, `BAD_USER_INPUT`, `NOT_FOUND`, `CONFLICT`, `SERVICE_UNAVAILABLE`, `INTERNAL_SERVER_ERROR` o el código de validación de GraphQL), además de `reason` (código de negocio, p. ej. `INSUFFICIENT_FUNDS`) y `correlationId`.
- Nunca incluye `stacktrace` ni mensajes de errores no controlados: lo desconocido responde "Error interno" y el detalle va al log con el `correlation_id`.

### `correlation_id`
- Se reutiliza el `x-correlation-id` si es un UUID válido; si no, se crea uno.
- Se devuelve en la cabecera y en `extensions.correlationId`.
- Se propaga en cada llamada interna desde el contexto de la petición (AsyncLocalStorage).
- La E2E verificó que aparece en los logs de los cinco procesos y en el libro mayor.

### Llamadas internas
- **Timeouts:** 3 s por intento; 25 s para iniciar la SAGA, por encima de la espera síncrona del orquestador (20 s).
- **Reintentos selectivos:** máximo 1, con espera y *jitter*, **solo** si se cumplen las dos condiciones:
  - la operación es idempotente: GET, iniciar la SAGA con la misma `idempotency-key`, o parada y liberación (`ALREADY_*`);
  - el fallo es transitorio: red, timeout o 502/503/504.
  
  Nunca ante 4xx ni 500.
- **Sin *circuit breaker*:**
  - con timeouts cortos y un único reintento, un servicio caído cuesta como mucho unos 6 s por petición y no deja recursos colgados;
  - un *breaker* por réplica añade estado y umbrales que ajustar y probar, sin un beneficio demostrable a esta escala;
  - el polling del frontend (ADR-0017) tolera errores transitorios.
  
  Se reconsiderará con métricas reales de carga.
- **Readiness:** solo dependencias propias (tabla de flags). No incluye los servicios internos, para no propagar la caída de uno en cascada.

## Consecuencias

- **Positivas:**
  - Flujo completo verificado contra Floci con tokens reales de Cognito (E2E de 9 pruebas):
    - consultas;
    - SAGA completada y compensada;
    - parada y liberación;
    - autorización por flota y por rol;
    - flags;
    - validación;
    - propagación del `correlation_id`.
  - El BFF no conoce ninguna tabla de negocio.
- **Negativas:**
  - Algunos resolvers hacen varias llamadas (p. ej. `stopChargingSession`: sesión → SAGA → parada → liberación). Es aceptable por su baja frecuencia.
  - Los campos anidados (`events`, `telemetry`) se resuelven con una llamada por objeto. No hay DataLoader porque las listas están acotadas (≤ 50).
  - Con un solo reintento y sin *breaker*, una caída larga de un servicio devuelve `SERVICE_UNAVAILABLE` a cada petición durante esa caída.
