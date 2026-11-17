# ADR-0005: Idempotencia mediante IDs pre-generados, escrituras condicionales y tombstones

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§6.3 pregunta cómo se evita la falta de idempotencia si una petición o compensación se procesa dos veces. Con comunicación síncrona y reintentos ([ADR-0004](0004-comunicacion-sincrona-http-contratos-openapi.md)) son posibles:

- duplicados;
- respuestas perdidas;
- reordenamiento: una compensación llega antes que un avance tardío.

## Decisión

1. **Clave de idempotencia del cliente** (`idempotencyKey`) en la mutación. Se registra el ítem `IDEM#<fleetId>#<key>` con `attribute_not_exists`, así que una acción del usuario genera una sola SAGA.
2. El orquestador **pre-genera** `reservationId`, `debitId` y `sessionId` y los persiste **antes** de invocar a ningún servicio.
3. **Avances como `PUT` sobre el ID del recurso,** con `attribute_not_exists(PK)`:
   - mismo payload → `200` con el resultado original;
   - payload distinto → `409`.
4. **Compensaciones como transiciones condicionales,** por ejemplo `refund` solo si `status = DEBITED`. Una repetición responde `ALREADY_*` sin efectos.
5. **Tombstones:** una compensación sobre un recurso inexistente escribe un registro `VOIDED`, y un avance tardío con ese ID recibe `409 *_VOIDED/CANCELLED`.
6. **Rechazos de negocio persistidos** (`REJECTED_INSUFFICIENT_FUNDS`) para que la respuesta sea determinista.
7. **Atomicidad dentro de cada servicio** con `TransactWriteItems`. Ejemplo del débito: actualizar el saldo, crear el Debit y crear la LedgerEntry en una sola transacción, verificada en Floci.

## Alternativas

1. **Tabla de idempotencia genérica por `Idempotency-Key` en cada endpoint.** Funciona, pero no resuelve el reordenamiento ni permite compensar sin respuesta previa.
2. **Exactly-once mediante mensajería.** No existe en la práctica sin deduplicación; añade complejidad.
3. **IDs generados por cada servicio.** Si la respuesta se pierde, el orquestador no sabe qué compensar.

## Consecuencias

- **Positivas:** reintentos seguros en todas las capas y compensación posible aunque nunca llegue una respuesta. Se puede demostrar con una prueba de integración y en vivo.
- **Negativas:** los servicios guardan registros adicionales (tombstones, rechazos), que necesitan TTL o limpieza. Los contratos son más estrictos y el payload de cada `PUT` debe ser estable.
