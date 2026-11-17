# ADR-0009: Propagación de `correlation_id` y `saga_id`

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.5 exige logs JSON con el `correlation_id` de cada SAGA, el ambiente y el microservicio. §6.4 pide rastrear en CloudWatch el `correlation_id` de una SAGA fallida, que puede haberse reanudado tras un reinicio.

## Decisión

- **`correlation_id`:**
  - Lo genera el GraphQL API por request (UUID); reutiliza un `X-Correlation-Id` entrante si es un UUID válido.
  - Viaja en `X-Correlation-Id` en toda llamada interna.
  - Se devuelve en `extensions.correlationId`.
  - Se persiste en Saga, SagaEvent, LedgerEntry y FlagAudit.
- **`saga_id`:** lo genera el orquestador y viaja en `X-Saga-Id` y en los cuerpos de los `PUT`.
- El `RecoveryWorker` **reutiliza el `correlation_id` original** de la SAGA.
- En Node.js, el contexto se propaga con `AsyncLocalStorage`. El logger lo añade automáticamente a cada línea con los campos `service`, `environment` y `version`.

## Alternativas

1. **AWS X-Ray o OpenTelemetry con trazas distribuidas.** Más potente, pero no lo exige la especificación y su emulación en Floci no está verificada. Puede añadirse después, conservando `correlation_id` como clave de negocio.
2. **Pasar el contexto como parámetro en cada función.** Contamina el dominio con datos de infraestructura.

## Consecuencias

- **Positivas:** una sola búsqueda en CloudWatch devuelve el recorrido completo de la SAGA, incluidos los reintentos de recuperación.
- **Negativas:** hay que asegurar la propagación en cada cliente HTTP y en cada tarea asíncrona; se cubre con pruebas de integración.
