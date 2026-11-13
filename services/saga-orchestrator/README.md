# saga-orchestrator-service

Orquestador de la SAGA **"Reservar y Activar Carga"** (bounded context *Charging Orchestration*, ADR-0002/0003). Tiene persistencia propia (`aegisvolt-sagas-<env>`) y arquitectura hexagonal. Decisiones de la implementación: [ADR-0024](../../docs/adr/0024-saga-orquestada-implementacion-estados-lease-recuperacion.md). Diseño y diagramas: [02-saga.md](../../docs/architecture/02-saga.md). Contrato: `sagaOrchestratorV1` 1.1.0. Evidencia con datos de DynamoDB: [runbook](../../docs/runbooks/saga-demo.md).

> Es una SAGA con **compensaciones**, no una transacción ACID: cada servicio confirma su paso localmente y los fallos se corrigen con operaciones de negocio inversas, idempotentes y verificadas.

## Endpoints

| Endpoint | Caso de uso | Respuesta |
| --- | --- | --- |
| `POST /v1/sagas` (`idempotency-key`, `x-correlation-id`) | `ReserveAndActivateCharging` | `201` terminal · `202` en curso o `COMPENSATION_FAILED` · `409 IDEMPOTENCY_KEY_CONFLICT` |
| `GET /v1/sagas/{sagaId}` | `GetSaga` | Vista con pasos, claves idempotentes y fallo de compensación |
| `GET /v1/sagas/{sagaId}/events` | `ListSagaEvents` | Historial completo |
| `GET /v1/sagas?fleetId=&status=&limit=` | `ListFleetSagas` | — |
| `POST /v1/sagas/{sagaId}/compensation/retry` | `RetryCompensation` (controlado) | `200` / `202` · `409 SAGA_NOT_RETRYABLE` · `409 SAGA_BUSY` |
| `GET /health/live`, `GET /health/ready` | — | Readiness con drenado al apagar |

Recuperación: `RecoverPendingSagas`
- como worker en proceso (`RECOVERY_ENABLED`, `RECOVERY_INTERVAL_MS`);
- como tarea de una sola ejecución: `pnpm --filter @aegisvolt/saga-orchestrator-service saga:recover [--retry <sagaId>]`.

## Requisitos y cómo se cumplen

| # | Requisito | Implementación |
| --- | --- | --- |
| 1 | Persistir antes y después | `beginStep` / `beginCompensation` (`IN_PROGRESS`) se guarda antes de cada llamada; el resultado, después. Cada escritura es un `TransactWriteItems` con los eventos |
| 2 | Recuperación tras reinicio | `RecoverPendingSagas` (GSI2 por estado, lease vencido) repite el paso `IN_PROGRESS` con la misma clave |
| 3 | Claves idempotentes estables | `res_`/`dbt_`/`ses_<clave>`, y UUIDs de confirmación y compensaciones generados y **persistidos** al crear la SAGA |
| 4 | Sin ejecución concurrente | Lease condicional + `version`: `version = :leída AND leaseOwner = :yo` |
| 5 | Timeouts y reintentos acotados | Timeout por llamada; solo se reintentan errores transitorios (backoff + jitter, máximo N); los 4xx de negocio nunca |
| 6 | Sin ACID entre servicios | Compensaciones en orden inverso, cada una idempotente en su servicio |
| 7 | Datos mínimos para reanudar | La SAGA guarda la petición, los ids, las claves, `connectorPowerKw`, el plan, el fallo y la ronda |
| 8 | Compensado solo si se verifica | El `outcome` de cada compensación debe estar en el conjunto aceptado; si no, `UNVERIFIED_COMPENSATION` |
| 9 | `correlation_id` y `saga_id` | Cabeceras en cada llamada, logs JSON del observador, `SagaEvent.correlationId` |
| 10 | Recuperación de pendientes | Worker, tarea `saga:recover` y endpoint de reintento controlado |

## Estructura

```text
src/
  domain/          SagaTransaction (estados por hito), plan de compensación, RetryPolicy
  application/     ReserveAndActivateCharging, SagaExecutor, RecoverPendingSagas, RetryCompensation,
                   consultas · puertos: SagaRepository, StationReservationPort, BillingWalletPort,
                   EnergyDispatchPort, Clock, IdGenerator, SagaObserver
  infrastructure/  repositorio DynamoDB (lease + versión), clientes HTTP de los 3 servicios,
                   observador de logs, worker de recuperación
  presentation/    Express 5: rutas delgadas, problem+json, apagado ordenado
scripts/           create-local-table.ts · recover-sagas.ts (tarea controlada)
```

## Ejecutar y probar

```bash
pnpm --filter @aegisvolt/saga-orchestrator-service db:create-local-table
pnpm --filter @aegisvolt/saga-orchestrator-service dev                 # http://localhost:4100
pnpm --filter @aegisvolt/saga-orchestrator-service test                # dominio, aplicación, HTTP
pnpm --filter @aegisvolt/saga-orchestrator-service test:integration    # repositorio en Floci
REQUIRE_INTEGRATION=true pnpm test:e2e                                 # 4 servicios reales + Floci
```

| Suite | Casos clave |
| --- | --- |
| `test/domain` | Transiciones, plan de compensación, `COMPENSATION_FAILED` y reintentos, invariantes de `restore` |
| `test/application` | **Éxito** (persistencia antes y después, propagación), **fondos insuficientes**, **fallo de hardware**, pivote desconocido, **repetición de la petición inicial** (también simultánea), **repetición de una compensación**, **reinicio con paso intermedio**, plazo de avance, **fallo durante la compensación** (transitorio, no recuperable, no verificado, rondas agotadas), lease robado |
| `test/infrastructure` | Clasificación HTTP (2xx/4xx/5xx/timeout/red), cabeceras propagadas |
| `test/presentation` | `201`/`202`/`409`, reintento controlado, validación |
| `test/integration` | Floci: creación condicional, versión + lease, eventos atómicos, recuperación por GSI2, dos réplicas recuperando a la vez |
| `tests/e2e` | Los 7 escenarios con los servicios reales y evidencia de DynamoDB |

## Limitaciones

- La mutación GraphQL llega en la fase del GraphQL API; aquí el punto de entrada es `POST /v1/sagas`.
- El Dockerfile y el CronJob de recuperación llegan en la fase de Kubernetes; la tabla de cada ambiente, en la de IaC.
