# energy-dispatch-service

Microservicio de **despacho de energía** (bounded context *Energy Dispatch*): activa y detiene el cargador, registra sesiones de carga y su telemetría. Tiene persistencia propia en DynamoDB (`aegisvolt-dispatch-<env>`) y arquitectura hexagonal. Decisiones: [ADR-0023](../../docs/adr/0023-energy-dispatch-cargador-simulado-flags-y-telemetria.md). Contrato: `energyDispatchV1` (1.1.0) en [`packages/contracts`](../../packages/contracts/src/energy-dispatch/v1.ts), documentado en [docs/contracts](../../docs/contracts/README.md#energy-dispatch-v1).

## Responsabilidades y endpoints

| Responsabilidad | Endpoint | Caso de uso |
| --- | --- | --- |
| Iniciar sesión (paso 3 de la SAGA) | `PUT /v1/sessions/{sessionId}` | `StartChargingSession` |
| Detener sesión | `POST /v1/sessions/{sessionId}/stop` | `StopChargingSession` |
| Abortar (compensación) | `POST /v1/sessions/{sessionId}/abort` | `AbortChargingSession` |
| Registrar telemetría | `POST /v1/sessions/{sessionId}/telemetry` | `RecordTelemetry` |
| Consultar sesión | `GET /v1/sessions/{sessionId}` | `GetChargingSession` |
| Telemetría de una sesión | `GET /v1/sessions/{sessionId}/telemetry?limit=` | `ListSessionTelemetry` |
| Sesiones activas e históricas | `GET /v1/stations/{stationId}/sessions?active=&limit=&cursor=` | `ListStationSessions` |
| Estado del cargador | `GET /v1/stations/{stationId}/connectors/{connectorId}/charger` | `GetChargerStatus` |
| Probes | `GET /health/live`, `GET /health/ready` | — |

## Requisitos y cómo se cumplen

| # | Requisito | Implementación |
| --- | --- | --- |
| — | Puerto del cargador | `ChargerAdapter` (aplicación) e implementación `SimulatedChargerAdapter` (infraestructura). Los casos de uso solo conocen el puerto; `main.ts` inyecta el simulado |
| 1 | Inicio y parada idempotentes | Inicio por `sessionId` pre-generado: mismos términos → `200` sin llamar al cargador; otros → `409`. Parada → `STOPPED`, luego `ALREADY_STOPPED` sin escrituras |
| 2 | Transiciones válidas registradas | `ChargingSession` solo permite ACTIVE→COMPLETED/ABORTED; FAILED nace terminal. Cada transición `{from, to, at, reason}` se persiste y se expone |
| 3 | Persistencia propia | Tabla `aegisvolt-dispatch-<env>` con transacciones condicionales; ocupación del conector `CONN#` |
| 4 | Flag desde el mecanismo acordado | `SIMULATE_CHARGER_HARDWARE_FAULT` se lee de `aegisvolt-feature-flags-<env>` con `@aegisvolt/feature-flags` (caché de 5 s), en cada orden |
| 5 | Error controlado, clasificable y trazable | `422 CHARGER_HARDWARE_FAULT` con `faultCode: E-HW-001`, `simulated: true` y `sessionId`; sesión `FAILED` persistida; log `charger_fault` con `fault_class`, `correlation_id` y `saga_id` |
| 6 | Falla física ≠ fallo técnico | Física: resultado `FAULT` → `422`. Técnica: `ChargerUnavailableError` → `503 CHARGER_UNAVAILABLE` (reintentable). Otra → `500` |
| 7 | Health, validación, logging y apagado | Readiness por tabla ACTIVE; validación Zod del contrato y del dominio (incluida la coherencia P ≈ V·I); logs JSON por petición; apagado ordenado con drenado y plazo |

## Estructura

```text
src/
  domain/           ChargingSession (transiciones), TelemetryRecord, RequestedEnergy, ChargerFault, errores
  application/      StartChargingSession, StopChargingSession, AbortChargingSession, RecordTelemetry,
                    GetChargingSession, ListSessionTelemetry, ListStationSessions, GetChargerStatus
                    puertos: ChargerAdapter, SessionRepository, FeatureFlagReader, Clock
  infrastructure/   SimulatedChargerAdapter, repositorio DynamoDB, lector de flags, cliente AWS, readiness
  presentation/     Express 5: rutas delgadas, problem+json, middleware, apagado ordenado
  config.ts · composition.ts · main.ts
scripts/create-local-table.ts   tabla en Floci para desarrollo (rechaza endpoints no locales)
```

## Ejecutar en local (Floci)

```bash
scripts/floci/start.sh
cp services/energy-dispatch/.env.example services/energy-dispatch/.env
pnpm build:packages
pnpm --filter @aegisvolt/feature-flags flags:create-local-table local    # flags en false
pnpm --filter @aegisvolt/energy-dispatch-service db:create-local-table
pnpm --filter @aegisvolt/energy-dispatch-service dev                     # http://localhost:4103
```

Demostración de la falla simulada, sin reiniciar el servicio:

```bash
scripts/flags/set.sh local SIMULATE_CHARGER_HARDWARE_FAULT true    # PUT de una sesión nueva → 422 E-HW-001
scripts/flags/set.sh local SIMULATE_CHARGER_HARDWARE_FAULT false   # en ≤ FEATURE_FLAGS_CACHE_TTL_MS → 201
```

## Pruebas

```bash
pnpm --filter @aegisvolt/energy-dispatch-service test               # dominio, aplicación, HTTP, apagado
pnpm --filter @aegisvolt/energy-dispatch-service test:integration   # DynamoDB de Floci
```

| Suite | Casos clave |
| --- | --- |
| `test/domain` | Transiciones (stop/abort idempotentes, invariantes de `restore`), telemetría (rangos, P ≈ V·I, orden), alineación con el contrato |
| `test/application` | **Inicio correcto**, **sesión duplicada** (mismos y otros términos, simultánea), conector ocupado, carrera con parada del cargador, **parada** (idempotente, cargador caído), aborto doble y tombstone, **telemetría inválida**, **fallo inducido por la flag** (cambio en caliente), fallo técnico vs. físico |
| `test/presentation` | Códigos HTTP y `problem+json`, `422` con `faultCode` y `simulated`, `503 CHARGER_UNAVAILABLE` sin detalles, validación de cabeceras de la SAGA, timeout; apagado ordenado (drenado, petición en curso, corte por plazo) |
| `test/integration` | Ítems reales en Floci: sesión, conector y GSI2; duplicado sin reescritura; **flag leída de la tabla de flags**; **6 activaciones simultáneas en un conector → 1**; 4 del mismo id → 1 × `201`; telemetría con `ttl`; paginación; parada; compensación doble; atomicidad |

## Limitaciones y pendientes

- **Cargador simulado:** no hay hardware ni OCPP. El estado `CHARGING` se deriva de la ocupación registrada, y la telemetría la envía un cliente (p. ej. un simulador o las pruebas), no el cargador.
- **Autorización:** el servicio es interno; el GraphQL API aplica los roles (ADR-0008).
- **TTL de la telemetría:** el atributo `ttl` se escribe; habilitar el TTL de la tabla corresponde a Terraform (fase de IaC).
- **Contenedor:** el Dockerfile llega en la fase de Kubernetes; las tablas de cada ambiente, en la fase de IaC.
