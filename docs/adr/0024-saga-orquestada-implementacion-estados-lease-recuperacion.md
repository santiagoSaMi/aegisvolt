# ADR-0024: SAGA orquestada — estados por hito, persistencia antes y después, lease y recuperación

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Relación:**
  - implementa ADR-0003 (SAGA orquestada) y ADR-0005 en `saga-orchestrator-service`;
  - **sustituye el vocabulario de estados** de ADR-0003;
  - confirma ADR-0002 (orquestador dedicado).

## Contexto

La fase pide implementar `ReserveAndActivateCharging`: reservar, debitar, activar y completar, con compensaciones.

Requisitos:
- persistir el estado antes y después de cada paso;
- recuperarse tras un reinicio;
- claves idempotentes estables por paso y por compensación;
- evitar la ejecución concurrente de una misma SAGA;
- timeouts y política de reintentos que nunca reintente errores de negocio;
- no asumir ACID entre servicios;
- no marcar como compensado nada sin verificarlo;
- propagar `correlation_id` y `saga_id`;
- un mecanismo de recuperación de pendientes.

El enunciado de la fase situaba el orquestador "en la capa de aplicación de `apps/graphql-api`, según los ADR". **Eso contradice ADR-0002** (Aceptado), que lo ubica en un servicio dedicado y descarta explícitamente el GraphQL API. Se informó la contradicción y el autor decidió mantener ADR-0002.

## Decisión

### Ubicación
- `ReserveAndActivateCharging` vive en la capa de **aplicación** de `services/saga-orchestrator`, desacoplado de cualquier transporte.
- El GraphQL API (fase posterior) solo invoca `POST /v1/sagas`. Su resolver no tendrá lógica de la SAGA.

### Estados (sustituyen a los de ADR-0003)

| Antes (ADR-0003) | Ahora | Motivo |
| --- | --- | --- |
| `RESERVING`, `DEBITING`, `ACTIVATING`, `CONFIRMING` (paso en curso) | `RESERVATION_COMPLETED`, `BILLING_COMPLETED`, `DISPATCH_COMPLETED` (hito alcanzado) | Vocabulario pedido. El paso en curso se registra en `steps[paso] = IN_PROGRESS`, persistido antes de llamar |
| `COMPENSATION_PENDING`, `REQUIRES_ATTENTION` | `COMPENSATION_FAILED` (no terminal) | Un solo estado con el paso, el error, la ronda y `nextAttemptAt`. Sin `nextAttemptAt` requiere reintento controlado |

Los estados terminales son `COMPLETED`, `COMPENSATED` y `FAILED`. El contrato `saga-orchestrator` pasa a 1.1.0 como corrección *pre-release*, porque aún no tiene consumidores.

### Ejecución (`SagaExecutor`)
1. **Antes** de cada llamada persiste la intención (`beginStep` / `beginCompensation`: paso `IN_PROGRESS`, intento N, evento).
2. Llama al servicio con:
   - `x-correlation-id`: el original de la SAGA, también en la recuperación;
   - `x-saga-id`;
   - la **clave idempotente estable** del paso: `res_`/`dbt_`/`ses_<clave>`, o UUIDs generados al crear la SAGA para la confirmación y cada compensación.
3. **Después** persiste el resultado: hito alcanzado, rechazo y plan de compensación, o fallo transitorio.

Cada escritura es un `TransactWriteItems` (estado + eventos) condicionado a `version = :leída AND leaseOwner = :yo`.

### Clasificación y reintentos

| Respuesta | Tratamiento |
| --- | --- |
| 2xx validada con el contrato, con el estado esperado | Paso hecho |
| 4xx (salvo 408/425/429) | Rechazo **definitivo**, sin reintento. Si el código es de negocio conocido es el motivo; si no, `STEP_REJECTED` |
| Red, timeout (por llamada), 5xx, 408, 429 | Transitorio: backoff exponencial con *jitter* hasta N intentos |

- Si se agotan los reintentos, el resultado es **desconocido** y se compensa también el propio paso, porque las compensaciones dejan tombstone si el recurso no existe.
- En la activación (pivote) se consulta antes `GET /sessions/{id}`.

### Compensaciones
- El plan se fija al fallar, en orden inverso, y solo con lo necesario:
  - débito rechazado → `release`;
  - falla de hardware → `refund` y después `release`;
  - resultado desconocido de la activación → `abort`, `refund` y `release`.
- Una compensación solo se marca hecha si la respuesta **verifica** el efecto (conjunto de `outcome` aceptados). Si no, `UNVERIFIED_COMPENSATION`.
- Si falla:
  - hay intentos inmediatos;
  - después, `COMPENSATION_FAILED` con paso y error;
  - si el error es transitorio, rondas automáticas con backoff largo;
  - si no es recuperable o se agotan las rondas, solo un **reintento controlado** (`POST /v1/sagas/{id}/compensation/retry` o `pnpm saga:recover --retry`).
- Las compensaciones ya verificadas nunca se repiten.

### Concurrencia y recuperación
- **Lease:** `leaseOwner` y `leaseExpiresAt` en el ítem Saga. Se toma con un `UpdateItem` condicional (libre, vencido o propio) y se renueva en cada escritura. Una réplica que pierde el lease falla en su siguiente escritura y se detiene.
- **`RecoverPendingSagas`:**
  - consulta GSI2 (`STATUS#<estado>`) para los estados no terminales;
  - toma el lease de las SAGAs inactivas o con reintento vencido;
  - registra `RECOVERED` o `COMPENSATION_RETRY_REQUESTED`;
  - antes del pivote y fuera de plazo, compensa en vez de avanzar;
  - continúa desde el estado persistido.
  
  Se ejecuta como worker en proceso (al arrancar y cada 10 s), como tarea de una sola ejecución (`saga:recover`, apta para CronJob) y como reintento puntual.
- **Petición inicial idempotente:** `sagaId = saga_<idempotency-key>`. La repetición devuelve la misma SAGA y, si quedó a medias con el lease libre, la reanuda.
- **Respuesta HTTP:** `POST /v1/sagas` espera hasta `SAGA_SYNC_WAIT_MS`:
  - `201` si la SAGA terminó;
  - `202` si no (sigue en segundo plano con su lease, o quedó en `COMPENSATION_FAILED`).

### Defecto corregido de paso
Express 5 entrega los errores de `app.listen` (p. ej. `EADDRINUSE`) a su callback. Los cuatro `main.ts` lo ignoraban y el proceso salía con código 0 sin servir. Ahora registran un `fatal` y salen con código 1. Lo detectó la E2E.

## Alternativas

1. **Orquestador en el GraphQL API** (lo que pedía el enunciado). Descartado en ADR-0002: mezcla el borde con un proceso de larga duración y con el worker de recuperación.
2. **Mantener los estados de ADR-0003.** Son equivalentes, pero no coinciden con el vocabulario mínimo pedido. Los hitos más `IN_PROGRESS` por paso conservan la misma información.
3. **Bloqueo solo con `version`, sin lease.** Dos réplicas podrían llamar al mismo servicio antes de que una pierda la escritura. El lease evita la ejecución concurrente; la versión protege cada escritura.
4. **Cola con *outbox*** (SQS) en vez de un worker que consulta un índice. Más piezas (DLQ, deduplicación) sin una ventaja demostrable a esta escala.
5. **Step Functions** (ADR-0002).

## Consecuencias

- **Positivas:**
  - Demostrado contra Floci con los cuatro servicios reales (E2E):
    - éxito;
    - fondos insuficientes;
    - fallo de hardware;
    - repetición de la petición y de una compensación;
    - reinicio con el débito `IN_PROGRESS`, sin doble cobro;
    - fallo de compensación y recuperación tras reiniciar.
  - Evidencia de DynamoDB en el [runbook](../runbooks/saga-demo.md).
  - Historial completo y auditable por SAGA (`SagaEvent`) para el frontend y Prefect.
- **Negativas:**
  - Cuarta copia del middleware HTTP y del cliente AWS (ADR-0022). Ya conviene extraer un paquete `http-kit`; queda pendiente.
  - El evento `COMPENSATION_RETRY_REQUESTED` guarda el modo (`AUTOMATIC`/`MANUAL`) en `errorCode`. Es pragmático; un campo `detail` sería más limpio.
  - `listByFleet` filtra por estado después de aplicar `Limit`, así que una página puede traer menos elementos de los pedidos.
  - La E2E usa tiempos cortos (lease de 4 s, recuperación cada 0,5 s). En los ambientes rigen los valores por defecto.
