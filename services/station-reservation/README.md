# station-reservation-service

Microservicio de **disponibilidad y reserva temporal de conectores de carga** (bounded context *Station Reservation*). Tiene persistencia propia en DynamoDB (`aegisvolt-reservations-<env>`) y arquitectura hexagonal. Decisiones: [ADR-0021](../../docs/adr/0021-station-reservation-concurrencia-idempotencia-expiracion.md). Contrato: `stationReservationV1` (1.1.0) en [`packages/contracts`](../../packages/contracts/src/station-reservation/v1.ts), documentado en [docs/contracts](../../docs/contracts/README.md#station-reservation-v1).

## Responsabilidades y endpoints

| Responsabilidad | Endpoint | Caso de uso |
| --- | --- | --- |
| Registrar una estación con sus conectores | `PUT /v1/stations/{stationId}` | `RegisterStation` |
| Consultar estaciones | `GET /v1/stations/{stationId}`, `GET /v1/stations?city=` | `GetStation`, `ListStations` |
| Consultar conectores disponibles | `GET /v1/connectors/available?city=` o `?stationId=` | `GetAvailableConnectors` |
| Reservar temporalmente un conector | `PUT /v1/reservations/{reservationId}` (id pre-generado, SAGA) · `POST /v1/reservations` + `idempotency-key` | `CreateReservation` |
| Confirmar (la carga empezó) | `POST /v1/reservations/{id}/confirm` | `ConfirmReservation` |
| Liberar una reserva | `POST /v1/reservations/{id}/release` | `ReleaseReservation` |
| Consultar una reserva | `GET /v1/reservations/{id}` | `GetReservation` |
| Probes de Kubernetes | `GET /health/live`, `GET /health/ready` | — |

Los comandos de la SAGA llevan `x-correlation-id` y `x-saga-id`. Los errores son `application/problem+json` con el catálogo `ERROR_CODES` del contrato.

## Estados

| Conector | Significado |
| --- | --- |
| `AVAILABLE` | Libre |
| `RESERVED` | Bloqueo temporal de una reserva; vence en `holdExpiresAt` (120 s, o 300 s con *fast charge boost*) |
| `OCCUPIED` | Carga en curso (SAGA confirmada); ya no vence |
| `OUT_OF_SERVICE` | **Adicional:** mantenimiento o avería física; nunca se ofrece para reservar |

Transiciones de la reserva: `HELD → CONFIRMED → RELEASED`, `HELD → RELEASED`, `HELD → EXPIRED`. Los ids ya compensados quedan como *tombstone* (`VOIDED`).

## Garantías

1. **Reserva atómica.** Un `TransactWriteItems` actualiza el conector y crea la reserva juntos, con condiciones:
   - el conector tiene la versión leída y está disponible en `now` (`AVAILABLE`, o `RESERVED` con `holdExpiresAt <= now`);
   - el id de reserva no existe (`attribute_not_exists`).
   Si alguna condición falla, no se escribe nada.
2. **Dos flotas no reservan el mismo conector.** La transacción ganadora cambia la versión del conector. La perdedora falla, el caso de uso relee y el dominio responde `409 CONNECTOR_UNAVAILABLE`. Hay hasta 3 intentos; si se agotan, `503`.
3. **Idempotencia.** La clave es el `reservationId`: pre-generado en el `PUT`, o `res_<idempotency-key>` en el `POST`.
   - Misma clave con los mismos datos → `200` con la reserva original y sin nueva escritura.
   - Misma clave con otros datos → `409 IDEMPOTENCY_CONFLICT`.
   - Un id compensado (tombstone) → `409 RESERVATION_CANCELLED`.
4. **Liberación correcta.** `x-saga-id` debe ser la SAGA dueña (`409 RESERVATION_MISMATCH`). El conector solo se escribe con la condición `holdReservationId = <esta reserva>`, así que nunca se libera un bloqueo ajeno. Liberar una reserva inexistente deja un tombstone (`VOIDED`).
5. **Expiración sin depender del TTL.**
   - El vencimiento es *perezoso*: se evalúa con el reloj de cada petición, en el dominio y en la condición de DynamoDB. Un conector vencido está disponible en ese mismo instante.
   - Al tomar el conector, la reserva desplazada queda `EXPIRED` en la misma transacción.
   - El atributo TTL `expiresAtEpoch` solo se pone en registros terminales, para limpiarlos tras 30 días; nunca libera conectores.
6. **Timeouts:**
   - cada petición HTTP tiene un presupuesto (`HTTP_REQUEST_TIMEOUT_MS`, por defecto 5 s; al agotarse → `503`);
   - el SDK de DynamoDB tiene timeouts de conexión y de petición y pocos reintentos;
   - la configuración valida que `DYNAMODB_REQUEST_TIMEOUT_MS × DYNAMODB_MAX_ATTEMPTS < HTTP_REQUEST_TIMEOUT_MS`.

## Estructura

```text
src/
  domain/           Station, ChargingConnector, Reservation, ReservationPolicy, servicios de dominio
  application/      casos de uso, puertos (repositorios, reloj, flags), reintento optimista, errores
  infrastructure/   AWS SDK v3 (cliente con timeouts), repositorios DynamoDB, readiness, lector de flags (DynamoDB con caché, ADR-0025), reloj
  presentation/     Express 5: rutas y controllers delgados, validación con el contrato, middleware
                    (correlation_id, logs, timeout, errores → problem+json)
  config.ts         configuración validada (Zod)
  composition.ts    cableado de casos de uso
  main.ts           composition root y apagado ordenado
scripts/create-local-table.ts   tabla en Floci para desarrollo (rechaza endpoints no locales)
```

dependency-cruiser hace cumplir las dependencias:
- `domain` no depende de nada externo;
- `application` solo depende de `domain`;
- `presentation` e `infrastructure` no se importan entre sí;
- solo `main.ts`/`composition.ts` las conectan.

## Ejecutar en local (Floci)

```bash
scripts/floci/start.sh                                     # desde la raíz del repo
cp services/station-reservation/.env.example services/station-reservation/.env
pnpm build:packages
pnpm --filter @aegisvolt/station-reservation-service db:create-local-table
pnpm --filter @aegisvolt/station-reservation-service dev   # http://localhost:4101
```

El endpoint de AWS solo llega por `AWS_ENDPOINT_URL`. Con `APP_ENV=local` es obligatorio, para no apuntar nunca a AWS real por omisión. Fuera de local se omite y el SDK usa el endpoint regional.

## Pruebas

```bash
pnpm --filter @aegisvolt/station-reservation-service test               # unitarias + aplicación + HTTP
pnpm --filter @aegisvolt/station-reservation-service test:integration   # contra DynamoDB de Floci
REQUIRE_INTEGRATION=true pnpm test:integration                           # falla si Floci no responde (CI)
```

| Suite | Qué cubre |
| --- | --- |
| `test/domain` | Value Objects, transiciones de conector y reserva, política de *boost*, alineación con el contrato |
| `test/application` | Casos de uso sobre un almacén en memoria con las mismas condiciones que DynamoDB: reserva disponible, duplicada, conflicto de idempotencia, **concurrencia de dos flotas**, conector inexistente, vencimiento y desplazamiento, liberación válida, inválida e inexistente, confirmación, reintentos |
| `test/presentation` | App Express real: códigos HTTP, `problem+json`, cabeceras, `idempotency-key`, concurrencia, timeout `503`, `500` sin filtrar detalles, health |
| `test/integration` | DynamoDB de Floci con tabla temporal: catálogo por id y por GSI, reserva atómica (ítems verificados), duplicada, **8 reservas simultáneas → 1 ganadora**, escritura con versión obsoleta sin escrituras parciales, reserva inexistente, liberación válida e inválida, tombstone, expiración, confirmación `OCCUPIED`, readiness |

## Limitaciones y pendientes

- **Flags:** `ENABLE_FAST_CHARGE_BOOST` se lee de `aegisvolt-feature-flags-<env>` (tabla derivada de `APP_ENV`, caché de 5 s, valor seguro `false`). Cambiarla no requiere reiniciar ([ADR-0025](../../docs/adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md)). Empieza activa solo en `dev`.
- **Autenticación:** no hay autorización por rol en `PUT /v1/stations`. El servicio es interno (`ClusterIP` + NetworkPolicies) y el alta administrativa se expone a través del GraphQL API (ADR-0008).
- **Consultas por ciudad:** usan un GSI de consistencia eventual. La disponibilidad listada puede llevar un retraso breve, pero la reserva siempre se decide con lectura consistente y escritura condicional.
- **Tabla:** en los ambientes la crea Terraform (fase de IaC); `db:create-local-table` es solo para desarrollo.
- **Contenedor:** el Dockerfile llega en la fase de Kubernetes.
