# ADR-0003: SAGA orquestada con máquina de estados persistente en DynamoDB

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.3 exige una SAGA de tres pasos (reserva, débito y activación) con compensaciones definidas, y permite orquestación o coreografía. La sustentación pide demostrar el rollback en vivo, inspeccionar las tablas y explicar la idempotencia (§6.3). Hay que soportar reinicios del coordinador.

## Decisión

- **SAGA por orquestación**, implementada en `saga-orchestrator-service`.
- **Máquina de estados explícita en el dominio:**
  - estados de avance: `STARTED`, `RESERVING`, `DEBITING`, `ACTIVATING`, `CONFIRMING`;
  - estados de compensación: `COMPENSATING`, `COMPENSATION_PENDING`;
  - estados terminales: `COMPLETED`, `COMPENSATED`, `FAILED`, `REQUIRES_ATTENTION`.
- **Persistencia** en `aegisvolt-sagas-<env>`. Cada transición es un `TransactWriteItems` que actualiza la Saga (con `version` condicional) e inserta un `SagaEvent`. Floci 2.4.0 verificó que esta operación es atómica.
- **Compensación en orden inverso:** `abort` de la sesión (añadido, ver P-09) → `refund` del débito → `release` de la reserva.
- **Débito del cargo estimado,** como dice §2.3 (P-08).
- **`RecoveryWorker`** con *lease* para reanudar SAGAs no terminales. Detalle en [02-saga.md](../architecture/02-saga.md).

## Alternativas

1. **Coreografía con eventos** (SNS/SQS/EventBridge, disponibles en Floci). Acopla menos en el tiempo, pero el flujo queda repartido entre servicios. Es más difícil de explicar y auditar en una defensa por preguntas, y exige *outbox*, deduplicación de mensajes y manejo de DLQ para lograr la misma garantía.
2. **Orquestación en memoria sin persistir el estado.** Más simple, pero pierde la SAGA si el pod se reinicia. Inaceptable.
3. **Step Functions.** Ver ADR-0002.

## Consecuencias

- **Positivas:**
  - Flujo visible en un solo lugar.
  - Historial auditable con `SagaEvent`, que alimenta el panel del frontend y la auditoría de Prefect.
  - Demostración directa en DynamoDB.
- **Negativas:**
  - El orquestador es un punto crítico; se mitiga con réplicas, *lease* y recuperación.
  - Hay acoplamiento temporal síncrono con los servicios ([ADR-0004](0004-comunicacion-sincrona-http-contratos-openapi.md)).
