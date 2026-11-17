# ADR-0030: Prefect como auditor de solo lectura a través de las APIs de cada servicio

- **Estado:** Aceptado
- **Fecha:** 2026-11-14
- **Reemplaza en parte:** [ADR-0014](0014-observabilidad-cloudwatch-fluent-bit-prefect.md). Prefect ya no lee las tablas de DynamoDB, y P-19 queda revisado.

## Contexto

§2.5 pide flujos de Prefect que monitoreen la salud de los tres ambientes y "auditen la consistencia de las transacciones SAGA en DynamoDB (detectando transacciones huérfanas o compensadas)". ADR-0014 lo resolvió con una excepción de solo lectura a Database-per-Service: Prefect leería las cinco tablas (P-19).

El requisito de esta fase es más estricto:

- las auditorías respetan los límites de cada servicio y usan APIs o consultas autorizadas, **sin leer bases de datos ajenas**;
- Prefect es observabilidad y auditoría, **no un segundo orquestador** de la SAGA.

Este requisito contradice la letra de §2.5 ("en DynamoDB") y la decisión de ADR-0014. Prevalece el requisito explícito del autor: los datos siguen siendo los de DynamoDB, pero llegan por la API de su servicio dueño. Así se mantiene la regla 5 de CLAUDE.md (ningún servicio accede a la base de datos de otro).

## Decisión

### Proyecto independiente

`prefect/` es un proyecto Python 3.12 (paquete `aegisvolt_observability`, `pyproject.toml`), fuera del workspace de pnpm. Usa **Prefect 3.9.0** (2026-10-21), `boto3` 1.43.118, `pytest` 9.2.0, `ruff` 0.17.3 y `mypy` 2.4.1, todas con versión exacta y publicadas hace más de 14 días. `httpx` y `pydantic` llegan con Prefect.

### Capas

| Capa | Contenido | Prefect |
| --- | --- | --- |
| `model.py` | Vistas de los recursos (SAGA, reserva, débito, sesión, movimiento), `Rule`, `Finding` y umbrales | No |
| `rules/` | Reglas de detección como **funciones puras** (sin E/S), con id, enunciado, justificación, severidad y acción | No |
| `clients.py` | Clientes HTTP de **solo lectura** por servicio (contratos de `packages/contracts`) | No |
| `tasks.py` | Una consulta por task, con reintentos (2, espera de 2 s y 10 s), timeout de 60 s, sin caché y con logging | Sí |
| `flows/` | Componen tasks, evalúan reglas y publican reportes y métricas | Sí |

### Acceso a datos: solo APIs, solo GET

| Dato | API (dueño) |
| --- | --- |
| SAGAs por estado y antigüedad, en todas las flotas | **Nuevo** `GET /v1/audit/sagas` (orquestador, contrato 1.2.0). Usa el índice GSI2 que ya existía para la recuperación, sin Scan y con cursor opaco ligado al estado |
| SAGA por id | `GET /v1/sagas/{sagaId}` |
| Reservas de una flota | `GET /v1/reservations?fleetId=` (station-reservation) |
| Libro mayor de una flota, débito por id | `GET /v1/wallets/{fleetId}/transactions`, `GET /v1/debits/{debitId}` (billing-wallet) |
| Sesión por id | `GET /v1/sessions/{sessionId}` (energy-dispatch) |
| Salud | `/health/live` y `/health/ready` de las cinco unidades |

- **Flotas a revisar:** las de las SAGAs actualizadas en la ventana (cualquier estado), más las configuradas (`audit.fleets`).
- **Trazabilidad:** todas las consultas de una ejecución llevan el mismo `x-correlation-id`, así que la propia auditoría aparece en CloudWatch.
- **Errores:**
  - 404 es "no existe";
  - un tombstone (409 `DEBIT_VOIDED`/`RESERVATION_CANCELLED`, o sesión `VOIDED`) es "anulado";
  - red, timeout o 5xx se reintentan, y si persisten la entidad se informa como **no evaluada**. Una caída nunca se convierte en hallazgo.
- **Sin credenciales de DynamoDB:** Prefect solo usa boto3 para publicar métricas (`AegisVolt/Audit`) y comprobar que existen los log groups (metadatos), siempre contra Floci.

### No es un orquestador

Los flows nunca llaman a operaciones que cambian estado (`POST`/`PUT`): detectan y reportan. Cada regla indica la **acción** y el runbook, que ejecuta una persona; por ejemplo, el reintento controlado de una compensación lo hace el operador. Lo verifican las pruebas: las auditorías solo hacen `GET`.

### Umbrales

Salen de la configuración del orquestador: plazo de avance de 60 s y recuperación tras 15 s, cada 10 s.

| Umbral | Valor | Motivo |
| --- | --- | --- |
| `stale_after` | 600 s | ~7 veces el peor caso. Superarlo significa que la recuperación no actúa, no que la SAGA vaya lenta |
| `settle` | 120 s | Lo más reciente no se juzga: puede estar en curso y las lecturas a varios servicios no son atómicas |
| `compensation_retry_grace` | 300 s | Tolerancia tras `nextAttemptAt` |
| `session_end_grace` | 300 s | Tiempo para que se libere la reserva tras terminar la carga |

### Reglas

Están en `prefect/README.md`, con el enunciado completo, y cada reporte las incluye.

| Flow | Reglas |
| --- | --- |
| `environment_health_monitor` | HEALTH-001: un ambiente está OPERATIONAL si sus 5 unidades están listas y existen sus log groups; DOWN si ninguna responde; DEGRADED en otro caso |
| `saga_consistency_audit` | SAGA-001 detenida · SAGA-002 compensación fallida sin reintento · SAGA-003 reintento vencido · SAGA-004 COMPLETED sin carga · SAGA-005 carga activa en una SAGA sin éxito |
| `reservation_consistency_audit` | RES-001 activa sin SAGA · RES-002 activa con SAGA sin éxito · RES-003 HELD con SAGA COMPLETED · RES-004 conector ocupado sin carga · RES-005 hold de una SAGA detenida |
| `billing_consistency_audit` | BIL-001 débito sin SAGA · BIL-002 sin reembolso en SAGA sin éxito · BIL-003 débito sin sesión · BIL-004 reembolso pendiente · BIL-005 reembolso de una carga exitosa · BIL-006 doble reembolso |

### Resultados

- Cada flow publica un **markdown artifact** con las reglas evaluadas (enunciado y justificación), el conteo y cada hallazgo con los hechos observados, más un **table artifact** de hallazgos.
- Publica métricas en CloudWatch, namespace `AegisVolt/Audit`: `Findings`, `FindingsByRule` y `AuditErrors`, y en salud `EnvironmentHealthy` y `ServiceReady`.
- Se ejecutan con `serve` (deployments con intervalo) contra un Prefect Server local, con su dashboard.

## Alternativas

1. **Leer DynamoDB directamente** (ADR-0014). Detecta incluso lo que una API podría ocultar, pero rompe Database-per-Service y el requisito de esta fase, acopla Prefect al modelo de persistencia de cada servicio y exige credenciales de lectura de todas las tablas.
2. **Endpoints de auditoría en cada servicio**, con índices nuevos por estado para reservas y débitos. Cubre también las entidades de flotas sin SAGAs en la ventana, pero añade índices y rutas a tres servicios. Con un solo endpoint nuevo (el del orquestador, sobre un índice existente) y las APIs actuales se cubren las reglas pedidas. Queda como mejora si aparece ese punto ciego.
3. **Reparar automáticamente** (reintentar compensaciones desde Prefect). Convertiría a Prefect en un segundo orquestador, con riesgo de carreras con el `RecoveryWorker`. Prohibido por el requisito.
4. **Logs Insights o CloudWatch como fuente.** Los logs son evidencia, no el estado autoritativo; además Floci no ejecuta `stats` (L-09).

## Consecuencias

- **Positivas:**
  - Prefect depende de contratos versionados, no de esquemas de tablas.
  - Las reglas son puras y están probadas con fixtures.
  - Cada hallazgo cita su regla y los hechos.
  - La auditoría es trazable por `correlation_id`.
- **Negativas:**
  - Punto ciego: una reserva o un débito de una flota sin SAGAs en la ventana, y que no esté en `audit.fleets`, no se revisa. Se mitiga configurando las flotas conocidas.
  - Más llamadas HTTP que una lectura directa, acotadas por la ventana, los filtros por estado y la paginación (`max_pages`).
  - Las APIs internas no tienen autenticación propia (ADR-0004). En Kubernetes, una NetworkPolicy solo debe permitir a Prefect alcanzar los Services, y Prefect solo hace `GET`.
