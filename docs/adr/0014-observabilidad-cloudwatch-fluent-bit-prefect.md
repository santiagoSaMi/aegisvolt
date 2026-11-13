# ADR-0014: Observabilidad con logs JSON en stdout, Fluent Bit hacia CloudWatch y Prefect como plano de auditoría

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.5 exige:
- logs JSON en CloudWatch con `correlation_id`, ambiente y microservicio, en grupos `/aegisvolt/<env>/...`;
- flujos de Prefect que monitoreen la salud de los tres ambientes;
- auditoría de la consistencia de las SAGAs en DynamoDB, detectando transacciones huérfanas o compensadas, con métricas reportadas.

Prefect 3.x (última verificada: 3.9.2) ofrece `prefect server start`, flows, tasks, deployments, schedules y artifacts (tabla y markdown).

## Decisión

- **Aplicaciones:** escriben JSON en stdout ([ADR-0009](0009-propagacion-correlation-id-y-saga-id.md)).
- **Fluent Bit** como DaemonSet, con salida `cloudwatch_logs` hacia `/aegisvolt/<env>/<service>`.
  - Los log groups y su retención los crea Terraform.
  - En local apunta a Floci. **Verificación pendiente** del endpoint; alternativa: un adaptador `CloudWatchLogSink` detrás del puerto del logger.
- **Métricas:** metric filters y alarmas de una sola métrica. Floci evalúa solo alarmas de una sola métrica.
- **Prefect Server + worker** en contenedores locales como plano de observabilidad transversal, con los flows `environment_health`, `saga_consistency_audit` y `trace_correlation`:
  - leen DynamoDB y CloudWatch con boto3, **solo lectura**;
  - publican artifacts y métricas `AegisVolt/Audit`.
- La base de metadatos interna de Prefect no es un dato de negocio (P-18). La lectura de las tablas de otros servicios es una excepción de auditoría (P-19).

## Alternativas

1. **Envío a CloudWatch desde el código** (SDK en cada servicio). Acopla las apps a CloudWatch y añade latencia y errores de red al camino de la petición. Es la alternativa si Fluent Bit no funciona con Floci.
2. **CloudWatch Observability add-on / agente.** Específico de EKS real y no verificable en Floci.
3. **Prefect Cloud.** Servicio externo con cuenta propia; no hace falta para el alcance académico.
4. **Que Prefect consulte los servicios por HTTP** en lugar de DynamoDB. Respeta mejor Database-per-Service, pero la especificación pide auditar "en DynamoDB", y la lectura directa detecta inconsistencias que una API podría ocultar.

## Consecuencias

- **Positivas:** las aplicaciones quedan desacopladas del destino de los logs, y la trazabilidad por `correlation_id` es demostrable con un solo filtro. La auditoría es independiente del orquestador.
- **Negativas:** hay más piezas que operar (DaemonSet y Prefect), y Prefect necesita acceso de lectura a todas las tablas de los tres ambientes.
