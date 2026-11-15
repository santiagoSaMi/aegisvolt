# AegisVolt · Observabilidad y auditoría con Prefect

Proyecto Python **independiente** (fuera del workspace de pnpm) con los flows de Prefect que supervisan los ambientes y auditan la consistencia de la SAGA "Reservar y Activar Carga". Decisión: [ADR-0030](../docs/adr/0030-prefect-auditoria-solo-lectura-por-apis.md). Es el único componente en Python del proyecto (CLAUDE.md, regla 2).

**Principios**

- **Solo lectura, solo APIs.** Cada dato viene de la API pública de su servicio dueño. Prefect no tiene credenciales de las tablas y nunca hace `POST` ni `PUT`; las pruebas lo verifican.
- **No es un orquestador.** Detecta y reporta. Cada regla indica la acción y el runbook, que ejecuta una persona.
- **Ningún hallazgo sin regla.** Cada hallazgo cita el id, el enunciado exacto, la justificación de negocio y los hechos observados.
- **Una caída no es una inconsistencia.** Si un servicio no responde tras los reintentos, la entidad queda como *no evaluada*.

## Flows

| Flow | Qué hace | Fuentes (solo GET) |
| --- | --- | --- |
| `environment_health_monitor` | `/health/live` y `/health/ready` de las 5 unidades de cada ambiente, y existencia de sus log groups. Termina en Failed si algún ambiente no está OPERATIONAL (`strict`) | Servicios; metadatos de CloudWatch |
| `saga_consistency_audit` | SAGAs detenidas, compensaciones fallidas y SAGAs terminadas que contradicen su carga | Orquestador (`/v1/audit/sagas`, `/v1/sagas/{id}`), energy-dispatch |
| `reservation_consistency_audit` | Reservas huérfanas o que bloquean conectores | station-reservation (`/v1/reservations?fleetId=`), orquestador, energy-dispatch |
| `billing_consistency_audit` | Débitos sin sesión, reembolsos pendientes y anomalías del libro mayor | billing-wallet (`/v1/wallets/{fleet}/transactions`, `/v1/debits/{id}`), orquestador, energy-dispatch |

- **Composición:** cada flow se arma con **tasks reutilizables** (`tasks.py`), una consulta por task.
- **Reintentos:** 2, con esperas de 2 s y 10 s, sin caché.
- **Timeouts:** los aplica cada cliente: httpx corta cada petición a los 3 s y las páginas están acotadas; boto3 usa 5 s. `timeout_seconds` de Prefect no se usa porque no interrumpe una llamada bloqueante en una task síncrona.
- **Logging:** con `get_run_logger`.
- **Trazabilidad:** todas las consultas de una ejecución llevan el mismo `x-correlation-id`, así que la auditoría también es trazable en los logs de los servicios.

## Reglas de detección

Umbrales (configurables), justificados con la configuración del orquestador (ADR-0030):

- `stale_after`: 600 s;
- `settle`: 120 s. Lo más reciente no se juzga;
- `compensation_retry_grace`: 300 s;
- `session_end_grace`: 300 s.

| Regla | Condición | Por qué es una inconsistencia |
| --- | --- | --- |
| **HEALTH-001** | Un ambiente está OPERATIONAL solo si las 5 unidades responden `/health/ready` y existen sus log groups; DOWN si ninguna responde `/health/live`; DEGRADED en otro caso | Un ambiente no puede ejecutar la SAGA sin sus cinco unidades |
| **SAGA-001** | La SAGA está en un estado no terminal y sin cambios desde hace más de `stale_after` | La recuperación (15 s) no la está procesando; el conector y el saldo quedan retenidos |
| **SAGA-002** | `COMPENSATION_FAILED` sin `nextAttemptAt` | Se agotaron las rondas automáticas: nadie volverá a compensar |
| **SAGA-003** | `COMPENSATION_FAILED` con `nextAttemptAt` vencido hace más de la tolerancia | El worker de recuperación no está reintentando |
| **SAGA-004** | COMPLETED, pero la sesión no existe, está anulada o está en FAILED/ABORTED | Se cobró una carga que energy-dispatch no registra |
| **SAGA-005** | COMPENSATED o FAILED, con la sesión aún ACTIVE | Se entrega energía reembolsada o no cobrada |
| **RES-001** | Reserva HELD/CONFIRMED cuya SAGA no existe | Huérfana: nadie la liberará |
| **RES-002** | Reserva HELD/CONFIRMED con su SAGA COMPENSATED o FAILED | `RELEASE_RESERVATION` debía liberarla |
| **RES-003** | Reserva HELD con su SAGA COMPLETED | COMPLETED exige CONFIRMATION |
| **RES-004** | Reserva CONFIRMED con la sesión no ACTIVE desde hace más de `session_end_grace` | El conector queda OCCUPIED sin carga |
| **RES-005** | Reserva HELD con su SAGA detenida más de `stale_after` | El hold bloquea el conector (ver SAGA-001) |
| **BIL-001** | Débito DEBITED cuya SAGA no existe | Nadie lo reembolsará si no hubo carga |
| **BIL-002** | Débito DEBITED con su SAGA COMPENSATED o FAILED | `REFUND_DEBIT` debía devolverlo |
| **BIL-003** | Débito DEBITED, SAGA COMPLETED y sesión inexistente, anulada o FAILED/ABORTED | Cobro sin carga correspondiente |
| **BIL-004** | Débito DEBITED, SAGA en COMPENSATING o COMPENSATION_FAILED con `REFUND_DEBIT` en el plan, detenida más de `stale_after` | Compensación de dinero que no termina |
| **BIL-005** | Débito REFUNDED con su SAGA COMPLETED | Una SAGA completada no compensa |
| **BIL-006** | Más de un REFUND en el libro mayor para el mismo débito | El reembolso es idempotente: dos devoluciones abonan dos veces |

El texto completo de cada regla está en `src/aegisvolt_observability/rules/`, y cada reporte lo incluye.

## Instalación

Requisitos: Python 3.12 (verificado 3.12.3) con el módulo `venv`. No hace falta instalar paquetes del sistema.

```bash
cd prefect
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

Las versiones son exactas en `pyproject.toml`, todas publicadas hace más de 14 días:

- **Ejecución:** `prefect` 3.9.0, `boto3`/`botocore` 1.43.118.
- **Desarrollo:** `pytest` 9.2.0, `ruff` 0.17.3, `mypy` 2.4.1.

## Configuración

Es un archivo TOML validado (pydantic) y se elige con `AEGISVOLT_AUDIT_CONFIG`; por defecto, `config/local.toml`.

| Archivo | Para qué |
| --- | --- |
| `config/local.toml` | Servicios de `pnpm dev` (puertos 4100–4103 y 4000). `test` y `prod` apuntan a puertos sin servicio: en local se reportan DOWN, que es su estado real |
| `config/demo.toml` | Stack de demostración `pnpm --filter @aegisvolt/e2e-tests demo:web` (puertos 24100–24104), con datos sembrados |
| `tests/fixtures/config.toml` | Pruebas (hosts simulados) |

Secciones:

- `[audit]`:
  - `lookback_hours`: ventana a revisar;
  - `fleets`: flotas a revisar además de las que aparecen en las SAGAs de la ventana;
  - `page_limit` y `max_pages`.
- `[thresholds]`: umbrales de tiempo.
- `[http]`: `timeout_seconds`.
- `[cloudwatch]`: métricas `AegisVolt/Audit` y comprobación de log groups. El endpoint solo puede ser Floci local; las credenciales son las ficticias de Floci.
- `[environments.<env>]`: URL base de cada unidad. En Kubernetes serían los Services internos.

## Ejecución local

```bash
# 1. Servicios con datos (por ejemplo, el stack de demostración) y Floci
scripts/floci/start.sh
pnpm --filter @aegisvolt/e2e-tests demo:web          # en otra terminal; ver docs/runbooks/web-console-demo.md

# 2. Prefect Server (dashboard en http://127.0.0.1:4200). Estado en prefect/.prefect-home (ignorado por Git)
cd prefect
export PREFECT_HOME=$PWD/.prefect-home PREFECT_API_URL=http://127.0.0.1:4200/api
.venv/bin/prefect server start --host 127.0.0.1 --port 4200          # en otra terminal

# 3a. Ejecutar una vez
export AEGISVOLT_AUDIT_CONFIG=config/demo.toml
.venv/bin/python -c "from aegisvolt_observability.flows import saga_consistency_audit as f; f(environment='dev')"
.venv/bin/python -c "from aegisvolt_observability.flows import environment_health_monitor as f; f(environments=['dev'])"

# 3b. O programarlos (deployments con intervalo: salud 5 min, SAGA 10 min, reservas y billing 15 min)
.venv/bin/python -m aegisvolt_observability.serve
```

## Dashboard y resultados

En `http://127.0.0.1:4200`:

- **Runs:** estado de cada ejecución, con sus task runs y logs. Cada hallazgo se registra como `WARNING` con su regla.
- **Artifacts:** por cada flow y ambiente,
  - `<flow>-<env>` (markdown): ventana revisada, `correlation_id` de las consultas, la tabla de **reglas evaluadas** (condición y justificación) con su conteo, y cada hallazgo con los hechos observados y la acción;
  - `<flow>-<env>-findings` (tabla): un hallazgo por fila, con regla, severidad, sujeto, `saga_id`, `fleet_id`, `correlation_id`, lo observado y la acción;
  - `environment-health` (tabla) y `environment-health-summary` (markdown).
- **Métricas en CloudWatch** (namespace `AegisVolt/Audit`):
  - auditorías: `Findings`, `FindingsByRule{Rule}` y `AuditErrors`, con las dimensiones `Environment` y `Audit`;
  - salud: `EnvironmentHealthy{Environment}` y `ServiceReady{Environment, ServiceName}`.

### Resultado verificado (2026-11-14, stack de demostración)

Contra los servicios reales se crearon por sus APIs:

- dos SAGAs COMPLETED;
- una FAILED (conector ultrarrápido sin carga reforzada);
- una COMPENSATED (falla de hardware simulada, con reembolso y liberación);
- una carga detenida directamente en energy-dispatch, sin pasar por el BFF que libera la reserva.

| Flow | Resultado |
| --- | --- |
| `environment_health_monitor` | dev OPERATIONAL (5/5 listas, log groups presentes); test y prod DOWN (no desplegados en local). Estado Failed por `strict` |
| `saga_consistency_audit` | 4 SAGAs revisadas, **0 hallazgos**: las SAGAs reales consistentes no generan falsos positivos |
| `reservation_consistency_audit` | 3 reservas (2 activas), **1 hallazgo RES-004**: la reserva de la carga detenida sin liberar |
| `billing_consistency_audit` | 3 débitos (6 movimientos), 0 hallazgos: el débito compensado está REFUNDED |

Capturas en `tests/e2e/.evidence/prefect/` (no versionadas). Para no esperar los 5 minutos de `session_end_grace`, esa ejecución usó `settle_seconds = 0` y `session_end_grace_seconds = 0`.

## Pruebas y calidad

```bash
.venv/bin/pytest -q          # 25 pruebas: reglas, clientes y flows de punta a punta
.venv/bin/ruff check src tests && .venv/bin/ruff format --check src tests
.venv/bin/mypy               # strict
```

- **Fixtures (`tests/fixtures/*.json`):** respuestas de las APIs en el formato de `packages/contracts`. Cada elemento lleva `_scenario`, que documenta qué regla debe dispararse o por qué no.
- **Reglas:** cada regla se prueba contra las fixtures con la matriz exacta de hallazgos esperados, incluidos los umbrales, los tombstones y la exigencia de que todo hallazgo explique su regla.
- **Clientes:** 404 se mapea a NOT_FOUND y un tombstone a VOIDED; 5xx y errores de red se reintentan; se prueban la paginación y las fechas en UTC.
- **Flows:** con `prefect_test_harness` y servicios simulados (`httpx.MockTransport`). Se comprueban los hallazgos esperados, que solo se hagan GET a los hosts esperados con un único `correlation_id`, y que un servicio caído deje entidades *no evaluadas* en lugar de hallazgos.

## Estructura

```
prefect/
  pyproject.toml
  config/                  local.toml · demo.toml
  src/aegisvolt_observability/
    model.py               vistas, Rule, Finding, umbrales
    rules/                 saga · reservations · billing · health (funciones puras)
    clients.py             clientes HTTP de solo lectura por servicio
    config.py              configuración validada
    tasks.py               tasks reutilizables (reintentos, logging)
    reporting.py           AuditReport y artifacts
    flows/                 los cuatro flows
    serve.py               deployments programados
  tests/                   fixtures, reglas, clientes y flows
```
