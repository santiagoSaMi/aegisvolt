# ADR-0023: energy-dispatch — puerto del cargador, falla simulada por flag, telemetría y apagado ordenado

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Relación:** implementa ADR-0005, ADR-0006, ADR-0007 y ADR-0020 en energy-dispatch-service, con el mismo estilo que [ADR-0021](0021-station-reservation-concurrencia-idempotencia-expiracion.md) y [ADR-0022](0022-billing-wallet-ledger-atomico-y-compensaciones.md).

## Contexto

El servicio ejecuta el paso 3 de la SAGA (activación del cargador, el pivote). Debe:
1. consultar el estado de los cargadores;
2. iniciar y detener sesiones;
3. registrar telemetría (`session_id`, `voltage`, `current`, `power_kw`, `energy_kwh`, `timestamp`);
4. consultar sesiones activas e históricas.

Requisitos adicionales:
- inicio y parada idempotentes;
- transiciones registradas;
- persistencia DynamoDB propia;
- `SIMULATE_CHARGER_HARDWARE_FAULT` leída del mecanismo de flags acordado, no de una constante;
- fallas físicas simuladas distinguibles de los fallos técnicos;
- *health/readiness*, validación, logging y apagado ordenado.

## Decisión

### Puerto `ChargerAdapter` y adaptador `SimulatedChargerAdapter`
- La aplicación depende solo del puerto `ChargerAdapter` (`getStatus`, `startCharging`, `stopCharging`). `main.ts` inyecta `SimulatedChargerAdapter`; un adaptador OCPP real lo sustituiría sin tocar los casos de uso.
- Los documentos de diseño llamaban al puerto `ChargerGateway`. Se renombró a `ChargerAdapter` / `SimulatedChargerAdapter`, como pide el enunciado de la fase.
- **Las órdenes se identifican por la sesión**, como el `transactionId` de OCPP: repetir una orden no tiene efecto adicional, y parar una sesión que el cargador no atiende es un no-op.

### Dos clases de fallo con contratos distintos

| Clase | Cómo llega a la aplicación | HTTP | Semántica para la SAGA |
| --- | --- | --- | --- |
| **Física** (el equipo reporta una falla, real o simulada) | Resultado `{ kind: 'FAULT', fault }` | `422 CHARGER_HARDWARE_FAULT` con `faultCode`, `simulated` y `sessionId` | Definitiva: la sesión queda `FAILED` y se compensa |
| **Técnica** (sin comunicación, *timeout*) | Excepción `ChargerUnavailableError` | `503 CHARGER_UNAVAILABLE`, sin detalles internos | Reintentable: el resultado es desconocido y se consulta `GET /v1/sessions/{id}` |
| Otra excepción | Excepción | `500 INTERNAL_ERROR` | Error interno |

El log de la falla física (`event: charger_fault`) incluye:
- `fault_class: PHYSICAL`, `fault_code` y `simulated`;
- `cause: feature_flag:SIMULATE_CHARGER_HARDWARE_FAULT`;
- `session_id`;
- `correlation_id` y `saga_id`, que añade el contexto de logs.

Así la falla queda clasificable y trazable.

### Flags: paquete `@aegisvolt/feature-flags` (ADR-0007)
- Paquete genérico con:
  - `DynamoDbFeatureFlagSource`: lee `FLAG#<key>`/`META` de `aegisvolt-feature-flags-<env>` y valida el ítem con `featureFlagsV1`;
  - `CachedFeatureFlagReader`: caché de 5 s por réplica, lecturas simultáneas coalescidas, y ante un fallo el último valor conocido o `false`, sin reintentar hasta que venza el TTL.
- La aplicación declara su propio puerto estrecho (`FeatureFlagReader` con `DispatchFlag`); el lector del paquete lo satisface por tipado estructural.
- **La flag la evalúa el adaptador simulado, no el dominio ni el caso de uso**: es una propiedad del cargador simulado. Se lee en cada orden, así que cambiarla en la tabla del ambiente cambia el comportamiento en ≤ TTL sin redesplegar. Esto se verificó contra Floci y en el servicio en ejecución.
- **Herramienta local:**
  - `flags:create-local-table` crea la tabla y siembra las flags en `false`;
  - `flags:set` escribe con versión condicional más un ítem de auditoría en la misma transacción *(sustituido en [ADR-0025](0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md) por la CLI del graphql-api, que usa `UpdateFeatureFlag`)*;
  - el envoltorio `scripts/flags/set.sh` la invoca.

  Ambos scripts rechazan endpoints que no sean locales. En los ambientes, el único escritor sigue siendo `setFeatureFlag` del GraphQL API.

### Persistencia (`aegisvolt-dispatch-<env>`)

| Ítem | Clave | Índices |
| --- | --- | --- |
| Sesión o tombstone | `SESSION#<id>` / `META` | GSI1 `STATION#<st>` / `<startedAt>#<id>` (histórico). GSI2 *sparse* `ACTIVE#<st>` / `<cn>#<id>`, solo mientras está ACTIVE (activas) |
| Telemetría | `SESSION#<id>` / `TEL#<timestamp>` | — (Query en la partición de la sesión). Lleva `ttl` |
| Ocupación del conector | `CONN#<st>#<cn>` / `META` (`activeSessionId`) | — |

Transacciones condicionales (todo o nada):

| Operación | Escrituras | Condiciones |
| --- | --- | --- |
| Inicio ACTIVE | sesión · ocupación del conector | sesión nueva (`attribute_not_exists`, bloquea ids con tombstone); conector libre o ya de esta sesión |
| Inicio FAILED | sesión | sesión nueva |
| Parada / aborto | sesión (reescrita sin atributos de GSI2) · liberación del conector | versión leída; el conector solo se libera si lo ocupa esta sesión |
| Telemetría | sesión (`lastTelemetry*`) · lectura | versión leída; lectura nueva |
| Aborto sin sesión | tombstone | id nuevo |

### Idempotencia y transiciones
- **Inicio:** el `sessionId` pre-generado es la clave.
  - Mismos términos → `200` con la sesión registrada, sin llamar al cargador (también si quedó `FAILED`).
  - Otros términos → `409 IDEMPOTENCY_CONFLICT`.
  - Tras un aborto → `409 SESSION_ABORTED`.
  - Otra sesión en el conector → `409 CONNECTOR_BUSY`.
- **Parada:** `POST /stop` → `STOPPED` o `ALREADY_STOPPED`, este último sin escrituras ni órdenes.
- **Aborto (compensación):** `ABORTED`, `ALREADY_ABORTED`, `ALREADY_FAILED` o `VOIDED`. Procesarlo dos veces no tiene efectos; está demostrado contra Floci (la versión no cambia).
- **Telemetría:** idempotente por (`sessionId`, `timestamp`). La misma lectura → `200`; otra lectura con el mismo instante → `409 IDEMPOTENCY_CONFLICT`.
- **Transiciones:** cada cambio de estado añade `{from, to, at, reason}` a `transitions`, que se persiste con la sesión y se expone en la vista. Es una invariante de `restore`: la última transición lleva al estado actual.
- **Energía nunca sin registro:** si esta petición energizó el cargador pero la sesión no quedó ACTIVE por ella, el caso de uso ordena parar esa sesión (*best-effort*). Ocurre cuando otra sesión ganó el conector, cuando la persistencia falló o cuando persisten conflictos.
- **Orden en parada y aborto:** primero se ordena parar al cargador y luego se registra. Si el cargador no responde (`503`), no se escribe nada y el reintento es seguro.

### Telemetría validada en el dominio
- Rangos físicos.
- **Coherencia `P ≈ V × I / 1000`**, con tolerancia de ±10 % y un mínimo de 1 kW.
- Tiempo estrictamente creciente y energía acumulada no decreciente; nunca anterior al inicio ni mayor que la energía solicitada.
- Solo en sesiones `ACTIVE`, aunque un reintento de una lectura ya registrada sigue respondiendo `200`.

### Apagado ordenado
`ReadinessGate` y `createGracefulShutdown` siguen estos pasos:
1. readiness pasa a `503`;
2. espera `SHUTDOWN_DRAIN_DELAY_MS`, para que Kubernetes saque el pod de los Endpoints;
3. `server.close()`, más un barrido periódico de conexiones *keep-alive* ociosas;
4. al vencer `SHUTDOWN_GRACE_MS`, corta las conexiones restantes;
5. libera el cliente AWS.

Es idempotente ante una segunda señal. La configuración exige `SHUTDOWN_GRACE_MS > HTTP_REQUEST_TIMEOUT_MS`.

### Contrato `energy-dispatch` 1.1.0
- **Nuevo:**
  - `stop`;
  - `POST telemetry`;
  - sesiones por estación;
  - estado del cargador;
  - campos opcionales en `sessionView`;
  - errores `SESSION_NOT_ACTIVE`, `CONNECTOR_BUSY`, `TELEMETRY_OUT_OF_ORDER` y `CHARGER_UNAVAILABLE (503)`.
- **Corrección *pre-release*:** la lectura de telemetría usa los campos mínimos del enunciado (`timestamp`, `currentA`, `energyKwh`, `temperatureC` opcional). Se acepta por la misma razón que en station 1.1.0: aún no hay consumidores implementados de esas operaciones.

## Alternativas

1. **Evaluar la flag en el caso de uso.** Mezcla una herramienta de demostración con la lógica de aplicación, y un adaptador real tendría que ignorarla. En el adaptador simulado es una propiedad del "hardware".
2. **Tratar el fallo técnico como falla física (422).** La SAGA compensaría una carga que quizá sí empezó. Separarlos permite verificar antes de compensar (ADR-0003).
3. **Ocupación del conector solo con un GSI.** Los GSI son eventualmente consistentes y no admiten escrituras condicionales; el ítem `CONN#` sí.
4. **Lector de flags HTTP o variables de entorno.** Descartado en ADR-0007.

## Consecuencias

- **Positivas:**
  - Demostradas contra Floci:
    - 6 activaciones simultáneas en un conector → 1 sesión y 5 × `CONNECTOR_BUSY`;
    - 4 activaciones simultáneas del mismo id → 1 × `201` y 3 × `200`;
    - una versión obsoleta no escribe nada;
    - la flag cambia el resultado sin reiniciar.
  - Fallos clasificables por código y status.
- **Negativas:**
  - Tercera copia del middleware HTTP y del cliente AWS. Sigue la decisión de ADR-0022; con tres servicios conviene evaluar un paquete `http-kit`, lo que queda pendiente.
  - Cada lectura de telemetría incrementa la versión de la sesión, de modo que lecturas muy frecuentes compiten con la parada. El reintento optimista lo resuelve a la escala del proyecto.
  - El cargador simulado no tiene estado físico: el estado `CHARGING` se deriva de la ocupación registrada.
  - station-reservation y billing-wallet siguen con el lector de flags provisional por configuración; migrarlos al paquete es una tarea pendiente y acotada.
