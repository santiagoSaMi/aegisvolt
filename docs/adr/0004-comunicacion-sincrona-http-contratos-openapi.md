# ADR-0004: Comunicación síncrona HTTP/JSON con contratos OpenAPI, timeouts y reintentos acotados

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

El orquestador y el GraphQL API invocan a los servicios de dominio. La integración de API Gateway REST limita la respuesta a 29 s por defecto. Los fallos de red pueden dejar resultados ambiguos. La regla 5 prohíbe el acceso cruzado a bases de datos.

## Decisión

- HTTP/1.1 con JSON a través de Services `ClusterIP`. Los errores siguen RFC 9457 (`problem+json` con `code` estable).
- Un **contrato OpenAPI 3.1** por servicio en `packages/contracts`, validado en pruebas por ambos lados ([ADR-0016](0016-estrategia-de-pruebas.md)).
- **Presupuesto de timeouts** decreciente por capa:
  - GraphQL → orquestador: 12 s;
  - espera síncrona de la SAGA: 8 s, después `202` y la SAGA continúa en segundo plano;
  - orquestador → servicio: 2 s por intento, con 3 intentos y backoff exponencial con jitter;
  - SDK de DynamoDB: `maxAttempts: 2`.
- Solo se reintentan errores de red, timeouts, `5xx` y `429`. **Nunca** las respuestas de negocio (`403`, `404`, `409`, `422`).
- Sin *circuit breaker* por ahora (regla 10); se reevalúa si las métricas lo justifican.

## Alternativas

1. **Mensajería asíncrona (SQS) por comandos.** Más tolerante a caídas, pero añade colas, DLQ y correlación de respuestas. La SAGA persistente con `RecoveryWorker` ya cubre la tolerancia a fallos con menos piezas.
2. **gRPC.** Tipado fuerte, pero añade herramientas de generación y complica la depuración con `curl`. No aporta nada a los requisitos.
3. **Reintentos en todas las capas.** Multiplican la carga (3 × 3 × 3) y exceden el límite de API Gateway.

## Consecuencias

- **Positivas:** fácil de depurar y demostrar. Los contratos explícitos permiten detectar cambios incompatibles en CI.
- **Negativas:** acoplamiento temporal (si un servicio cae, la SAGA espera o compensa); se mitiga con la recuperación. Además hay que mantener los OpenAPI sincronizados con el código.
