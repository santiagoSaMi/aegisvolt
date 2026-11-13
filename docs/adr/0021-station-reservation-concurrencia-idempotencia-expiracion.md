# ADR-0021: station-reservation — concurrencia, idempotencia, expiración y capa de presentación

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Relación:** implementa ADR-0005, ADR-0006 y ADR-0020 en station-reservation-service.

## Contexto

El servicio debe cumplir siete requisitos:
1. reservas atómicas mediante actualización condicional de DynamoDB;
2. que dos flotas no reserven a la vez el mismo conector;
3. idempotency key con detección de reutilización conflictiva;
4. liberación validada contra la reserva correcta;
5. una política de expiración que **no** dependa solo del borrado TTL, que es asíncrono;
6. health y readiness;
7. timeouts y errores consistentes.

La fase pide además los estados `AVAILABLE`, `RESERVED` y `OCCUPIED`, una capa llamada `presentation` con Express, y el endpoint de AWS configurable.

## Decisión

### Concurrencia y atomicidad
- **Concurrencia optimista con versión por ítem y condición de negocio.** Cada caso de uso:
  1. lee con `ConsistentRead`;
  2. el dominio decide;
  3. escribe con `TransactWriteItems`, condicionado a la versión leída.
  Al bloquear el conector, la condición de DynamoDB **repite la regla del dominio**: `AVAILABLE OR (RESERVED AND holdExpiresAt <= :now)`.
- **Reintento ante conflicto.** `ConcurrentModificationError` → el caso de uso relee y repite, hasta 3 intentos. La segunda flota obtiene `CONNECTOR_UNAVAILABLE` del dominio; si se agotan los intentos, `503` reintentable.

### Idempotencia
- **El id del recurso es la clave.** El `PUT /v1/reservations/{id}` usa el id pre-generado de la SAGA. El `POST /v1/reservations` + `idempotency-key` deriva `res_<clave>`. Así hay **un solo mecanismo**:
  - términos iguales → replay;
  - términos distintos → `IDEMPOTENCY_CONFLICT`.
- Reserva y tombstone comparten clave DynamoDB, de modo que `attribute_not_exists(PK)` también bloquea las creaciones tardías.

### Liberación
- `x-saga-id` debe ser la dueña de la reserva (`RESERVATION_MISMATCH`, error de dominio nuevo).
- El conector se escribe con la condición `holdReservationId = :reservationId`: nunca se libera un bloqueo ajeno.

### Expiración
- **Vencimiento perezoso:**
  - el conector se ve `AVAILABLE` en cuanto `now ≥ holdExpiresAt`;
  - la reserva desplazada se persiste `EXPIRED` en la misma transacción que la nueva reserva;
  - las lecturas informan el estado efectivo.
- El TTL de DynamoDB (`expiresAtEpoch`) solo se aplica a registros terminales, con retención de 30 días.

### Estados del conector
- `AVAILABLE`, `RESERVED`, `OCCUPIED` (carga en curso; sustituye al indicador `confirmed`) y `OUT_OF_SERVICE` (justificado por las averías físicas de §1.1).

### Capa de presentación
- **Express 5.3.0:** los errores de handlers async llegan al middleware de errores sin envoltorios.
- **Controllers delgados:** validan con los esquemas Zod del contrato, delegan y mapean con `z.input` del esquema.
- **Middleware:** `correlation_id` (ADR-0009), log por petición, presupuesto de tiempo (`503`) y errores → `problem+json` sin filtrar detalles en `5xx`.
- **Nombre:** la capa de entrada se llama `presentation`, como pide la fase. Después se unificó en todas las unidades desplegables, en CLAUDE.md y en las reglas de dependency-cruiser; antes se llamaba `interfaces`.

### Configuración e infraestructura
- **Endpoint AWS** solo por `AWS_ENDPOINT_URL` (Zod), obligatorio con `APP_ENV=local`.
- **Timeouts del SDK** con `NodeHttpHandler` (`connectionTimeout`/`requestTimeout`) y `maxAttempts` bajo. La configuración valida que el presupuesto de DynamoDB quepa en el HTTP.
- **Readiness:** `DescribeTable` (tabla `ACTIVE`) con caché de 2 s. **Liveness:** sin dependencias.
- **Flags:** `StaticFeatureFlagReader` provisional detrás del puerto `FeatureFlagReader`, hasta el lector DynamoDB de ADR-0007. *(Sustituido por el lector DynamoDB en [ADR-0025](0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md).)*

## Alternativas

1. **Solo condición de negocio, sin versión.** Insuficiente para la liberación y la confirmación, y no detecta lecturas obsoletas de otros campos.
2. **Bloqueo pesimista (ítem *lock* con TTL).** Más escrituras y depende de liberar el lock. La condición atómica de DynamoDB ya resuelve la exclusión.
3. **Tabla de idempotencia separada para el `POST`.** Una escritura y un ítem más. Derivar el id de la clave reutiliza el mecanismo de términos.
4. **Liberar holds con el TTL de DynamoDB o con un barrido periódico.** El TTL puede tardar horas o días; el barrido añade un proceso y aun así deja ventanas. El vencimiento perezoso es inmediato y no necesita procesos.
5. **Fastify o Hono en lugar de Express.** También válidos; se usa Express porque lo pide la fase y por su madurez.

## Consecuencias

- **Positivas:**
  - Exclusión mutua demostrada contra DynamoDB de Floci: 8 reservas simultáneas, 1 ganadora; sin escrituras parciales.
  - Idempotencia y liberación seguras.
  - Expiración exacta al milisegundo sin procesos auxiliares.
- **Negativas:**
  - Una reserva `HELD` vencida que nadie desplaza sigue persistida como `HELD`, aunque se informe `EXPIRED`. Prefect la verá así hasta que se toque (documentado para la auditoría).
  - Las consultas por ciudad usan un GSI eventual.
  - Hasta que exista el lector de flags, cambiar `ENABLE_FAST_CHARGE_BOOST` requiere reiniciar el servicio.
- **Corrección incluida:** la regla `adapters-do-not-depend-on-each-other` de dependency-cruiser tenía un grupo de captura de menos y prohibía importar dentro de una misma capa de adaptadores. Ahora usa tres grupos y se verificó con violaciones deliberadas.
