# Matriz de trazabilidad: requisitos de `proyecto_final.md` → evidencia

Auditoría técnica del 2026-11-19 sobre el commit `4e6e269` de `dev` (idéntico al de GitHub), con Floci 2.4.0, el clúster `aegisvolt-dev` (k3s v1.36) y las ejecuciones de GitHub Actions. Durante la auditoría no se añadió funcionalidad.

**Evidencias de esta corrida:** `infra/local/floci/.tmp/audit-20261119/` (ignorada por Git; un log por paso). Las de E2E están en `tests/e2e/.evidence/`.

Cómo demostrar cada requisito en vivo: [guía de sustentación](guia-sustentacion.md). Limitaciones citadas (L-NN): [limitations.md](limitations.md).

## Criterio de estado

| Estado | Significado |
| --- | --- |
| **Implementado** | Existe y se **ejecutó** con éxito en esta auditoría o en GitHub Actions; la evidencia se cita |
| **Implementado con limitación** | Funciona y se ejecutó, pero una parte del requisito no se puede demostrar en Floci o tiene un pendiente explícito |
| **Parcial** | Una parte del requisito no está cumplida, o solo se pudo verificar como configuración |
| **No verificable con Floci** | Está declarado y aplicado, pero Floci no ejecuta el comportamiento (solo guarda metadatos) |
| **No implementado** | No existe |

Nada se marca "implementado" solo por tener archivos declarativos.

## Resumen

| # | Requisito (sección) | Estado |
| --- | --- | --- |
| 1 | Frontend y flujo funcional (§2.1, §6.4) | Implementado |
| 2 | GraphQL (§2.2) | Implementado |
| 3 | Tres microservicios independientes (§2.2) | Implementado |
| 4 | Docker (§2.2) | Implementado |
| 5 | Kubernetes/EKS (§2.2) | Implementado con limitación |
| 6 | SAGA y compensaciones (§2.3, §6.3) | Implementado |
| 7 | Idempotencia (§6.3) | Implementado |
| 8 | Feature flags aisladas por ambiente (§2.2, §6.4) | Implementado con limitación |
| 9 | DynamoDB *database-per-service* (§2.4) | Implementado |
| 10 | Terraform y módulos (§2.4) | Implementado con limitación |
| 11 | Workspaces `dev`, `test`, `prod` (§2.4, §6.1) | Implementado |
| 12 | Backend S3, versionado y bloqueo (§2.4, §6.1) | Implementado con limitación |
| 13 | VPC, subredes, rutas y security groups (§2.4) | No verificable con Floci (aplicado; sin enrutamiento real) |
| 14 | VPC Endpoints y conectividad API Gateway (§2.4, §6.1) | Parcial |
| 15 | CloudWatch Logs y métricas (§2.5, §6.4) | Implementado con limitación |
| 16 | Prefect flows y tasks (§2.5, §6.4) | Implementado con limitación |
| 17 | Git flow y protección de ramas (§3.1, §3.2, §6.2) | Implementado con limitación (rechazo `GH013` no capturado) |
| 18 | CI/CD, `terraform plan` y `apply` (§3.3, §6.2) | Implementado con limitación |
| 19 | Canary y rollback (§3.3, §6.2) | Implementado con limitación |
| 20 | Seguridad y gestión de secretos | Implementado con limitación |

## Ejecución de esta auditoría

| Paso | Comando | Resultado |
| --- | --- | --- |
| Formato | `pnpm format:check` | OK |
| Lint (ESLint + dependency-cruiser) | `pnpm lint` | OK |
| Typecheck | `pnpm typecheck` | OK |
| Pruebas unitarias | `pnpm test` | **554** pasan (10 paquetes), 0 fallan |
| Build | `pnpm build` | OK |
| Integración contra Floci | `REQUIRE_INTEGRATION=true pnpm test:integration` | **46** pasan, 0 omitidas |
| E2E | `REQUIRE_INTEGRATION=true pnpm test:e2e` | **19/19** (SAGA, GraphQL con Cognito, consola en Chromium) |
| Prefect | `ruff`, `mypy` estricto, `pytest` | OK, **25** pasan |
| Workflows | `python3 scripts/ci/check-workflows.py` | OK (5 workflows, 23 jobs con nombre único) |
| Guardia de promoción | `scripts/ci/promotion-guard.test.sh` | Todas las pruebas pasan |
| Docker | `scripts/docker/build-images.sh` | 6 imágenes (web 94 MB, Node ≈ 294–320 MB) |
| Terraform estático | `scripts/ci/terraform-static-checks.sh` | `fmt`, `validate` (live en dev/test/prod), provider 6.71.0, sin endpoints reales |
| Terraform plan | `terraform-bootstrap.sh plan`, `terraform-global.sh plan`, `terraform-live.sh <env> plan` | **5/5 sin cambios** (sin deriva) |
| Evidencias de Terraform | `scripts/floci/terraform-evidence.sh` | **19/19** |
| Manifiestos K8s | `kubectl kustomize` + `kubectl apply --dry-run=server` | dev 53, test 53, prod 59 objetos aceptados por el API server, 0 errores |
| Smoke tests Floci | `scripts/floci/smoke-test.sh` | Todas las pruebas ejecutadas pasan |
| Operación K8s | `scripts/floci/k8s-verify.sh dev` | **17/17** |
| Red y API Gateway | `scripts/floci/network-verify.sh dev` | **29/29** (GraphQL por HTTPS de punta a punta; red como metadatos) |
| Flag + SAGA en vivo | demostración §6.3/§6.4 (ver 6 y 8) | COMPENSATED con la flag activa, COMPLETED al apagarla |
| Prefect en vivo | `environment_health_monitor`, `saga_consistency_audit` contra el clúster | OK (ver 16) |
| Canary | `scripts/floci/canary-demo.sh dev success` y `… failure` | **Promoted** y **Aborted** con rollback al 100 % estable (ver 19) |
| GitHub | API pública: reglas, PRs y ejecuciones | Ver 17, 18 y 19 |

No se ejecutó `terraform destroy`, no se eliminaron datos persistentes y nada se ejecutó contra AWS real.

---

## 1. Frontend y flujo funcional (§2.1, §6.4) — Implementado

- **Ubicación:** `apps/web` (React 19 + Apollo Client 4). Las vistas de §2.1 están en `src/features/`:
  - `dashboard` y `stations`: estado de estaciones y conectores;
  - `charging`: reserva y activación, con el progreso de la SAGA;
  - `feature-flags`: flags del ambiente;
  - `transactions` y `observability`: historial y compensaciones.
- **Evidencia:** `tests/e2e/test/web.e2e.test.ts`, en Chromium real contra Floci (parte de los 19/19 E2E de esta corrida):
  - credenciales inválidas;
  - flujo exitoso hasta `COMPLETED`;
  - flujo fallido: el administrador activa la flag desde la UI y la carga termina `COMPENSATED`, con el reembolso visible.
- **En el clúster:** la consola se sirve por API Gateway (`GET /` → 200 en `network-verify.sh dev`).
- **Comando:** `REQUIRE_INTEGRATION=true pnpm test:e2e`.
- **Limitación:** el "tiempo real" se implementa con *polling* configurable, no con WebSockets ([ADR-0017](adr/0017-frontend-spa-mismo-origen-polling.md)).

## 2. GraphQL (§2.2) — Implementado

- **Ubicación:** `apps/graphql-api/src/presentation/graphql/schema.ts`, con el contrato publicado en `apps/graphql-api/schema.graphql`.
  - 14 queries: estaciones, conectores, telemetría, transacciones, SAGA, flags y estado.
  - 4 mutaciones: `reserveAndActivateCharging`, `releaseReservation`, `stopChargingSession` y `updateFeatureFlag`.
- **Evidencia:**
  - 74 pruebas del BFF;
  - la prueba de snapshot del esquema;
  - las 15 operaciones de la consola validadas contra el SDL (`apps/web/test/unit/graphql-operations.test.ts`);
  - `graphql.e2e.test.ts`, con tokens reales de Cognito;
  - **en vivo**, `POST /graphql` por HTTPS a través de API Gateway → 200.
- **Comando:** `node apps/graphql-api/scripts/schema.ts --check` y el check `graphql-schema` de CI.
- **Limitación:** ninguna.

## 3. Tres microservicios independientes (§2.2) — Implementado

- **Ubicación:** `services/station-reservation`, `services/billing-wallet` y `services/energy-dispatch`, más `services/saga-orchestrator`, el orquestador de la SAGA. Cada uno tiene su dominio, su tabla, su Dockerfile y su `package.json` (arquitectura hexagonal).
- **Evidencia:**
  - `pnpm lint` ejecuta `dependency-cruiser`, que prohíbe importar código de otro servicio;
  - en el clúster, `k8s-verify.sh` comprueba con conexiones reales que las NetworkPolicies permiten solo lo previsto (`billing → station`: **bloqueado**; `graphql-api → billing`: permitido);
  - cada servicio corre en su propio Deployment.
- **Comando:** `pnpm lint` y `scripts/floci/k8s-verify.sh dev`.
- **Limitación:** ninguna.

## 4. Docker (§2.2) — Implementado

- **Ubicación:** un `Dockerfile` por unidad (`apps/*`, `services/*`).
  - Multi-stage, con la base fijada por digest y `pnpm deploy --prod`.
  - Usuario no root.
  - `scripts/docker/build-images.sh` genera etiquetas `sha-<commit>` y nunca `latest`.
- **Evidencia:**
  - las 6 imágenes se construyeron en esta corrida;
  - `k8s-verify.sh` confirma uid 1000 (Node) y 101 (web) con sistema de archivos de solo lectura;
  - en CI, `docker-build` y la puerta de Trivy (CRITICAL con parche) pasan.
- **Comando:** `scripts/docker/build-images.sh`.
- **Limitación:**
  - las imágenes Node pesan unos 300 MB, por el binario de Node 26;
  - en local la etiqueta lleva `-dirty-` si hay cambios sin commit.

## 5. Kubernetes/EKS (§2.2) — Implementado con limitación

- **Ubicación:**
  - `infra/terraform/modules/eks`: clúster, node group, roles, Pod Identity y kubeconfig;
  - `infra/k8s`: Kustomize base, overlays `dev`/`test`/`prod` y componentes `floci` y `canary`.
- **Evidencia:**
  - el clúster `aegisvolt-dev` lo creó Terraform: nodo `Ready`, 11/11 pods `Running`;
  - los 3 overlays fueron aceptados por el API server (`--dry-run=server`);
  - `k8s-verify.sh` 17/17: NetworkPolicies, Pod Security Admission `restricted`, `exec` y `port-forward`;
  - en GitHub, `deploy` creó y verificó clústeres temporales de `dev`, `test` y `prod`.
- **Comando:** `scripts/floci/k8s-verify.sh dev`; `kubectl apply --dry-run=server -f <render>`.
- **Limitación:**
  - el EKS de Floci es k3s de un solo nodo; el endpoint privado y los SG no se aplican (L-03);
  - en local solo existe `dev`, por memoria (L-11);
  - en GitHub, el k3s de `prod` falló al arrancar (`Exited (1)`) y pasó al **tercer intento**: es un fallo intermitente sin causa identificada.

## 6. SAGA y compensaciones (§2.3, §6.3) — Implementado

- **Ubicación:** `services/saga-orchestrator`: orquestación con máquina de estados persistente, *lease* y recuperación ([ADR-0024](adr/0024-saga-orquestada-implementacion-estados-lease-recuperacion.md)).
- **Evidencia E2E de esta corrida** (`tests/e2e/.evidence/`):

  | Escenario | Resultado en DynamoDB |
  | --- | --- |
  | Éxito | SAGA `COMPLETED`; reserva `CONFIRMED`; conector `OCCUPIED`; débito `DEBITED` |
  | Fondos insuficientes (falla el paso 2) | `COMPENSATED`, plan `[RELEASE_RESERVATION]`; débito `REJECTED_INSUFFICIENT_FUNDS`; reserva `RELEASED`; conector `AVAILABLE` |
  | Falla de hardware (falla el paso 3) | `COMPENSATED`, plan `[REFUND_DEBIT, RELEASE_RESERVATION]` (orden de §2.3); débito `REFUNDED`; reserva `RELEASED`; conector `AVAILABLE` |
  | Fallo durante la compensación | `COMPENSATION_FAILED` y, tras reiniciar el orquestador, `COMPENSATED` |

- **En vivo en el clúster `dev`** (§6.3), con la flag de falla activada por GraphQL:
  - SAGA `COMPENSATED`;
  - en `aegisvolt-billing-dev`, el débito queda `REFUNDED` con los movimientos `wtx_debit-…` y `wtx_refund-…`;
  - en `aegisvolt-reservations-dev`, la reserva queda `RELEASED`.
- **Comando:** `REQUIRE_INTEGRATION=true pnpm test:e2e`; demostración en `audit-20261119/23-live-flag-saga.log`.
- **Limitación:** §6.3 pide la demostración en `test`. En local no hay clúster de `test` (L-11); en GitHub, el deploy de `test` ejecutó la SAGA con la flag encendida y obtuvo `COMPENSATED` (`k8s-verify` en `test`).

## 7. Idempotencia (§6.3) — Implementado

- **Ubicación:**
  - IDs pregenerados y *tombstones* ([ADR-0005](adr/0005-idempotencia-ids-pregenerados-y-tombstones.md));
  - escrituras condicionales en los repositorios DynamoDB (`attribute_not_exists`);
  - `refund-wallet.ts` y `reservation-service.ts` devuelven `ALREADY_REFUNDED` y `ALREADY_RELEASED`.
- **Evidencia (E2E de esta corrida):**
  - una compensación repetida devuelve `ALREADY_REFUNDED` y `ALREADY_RELEASED`, y el libro mayor sigue con **un** débito y **un** reembolso, saldo 47 000 000 sin cambios;
  - repetir la petición inicial devuelve la **misma** SAGA con un solo cobro;
  - un `SIGKILL` con el débito ya aplicado se completa sin cobrar dos veces;
  - el smoke test de DynamoDB confirma `ConditionalCheckFailedException` ante una escritura duplicada.
- **Comando:** `REQUIRE_INTEGRATION=true pnpm test:e2e`; `scripts/floci/smoke-test.sh`.
- **Limitación:** ninguna.

## 8. Feature flags aisladas por ambiente (§2.2, §6.4) — Implementado con limitación

- **Ubicación:**
  - `packages/feature-flags`;
  - una tabla `aegisvolt-feature-flags-<env>` por ambiente, derivada de `APP_ENV`;
  - escritura auditada en el BFF ([ADR-0025](adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md));
  - semilla en Terraform (`infra/terraform/live/feature-flags.json`).
- **Evidencia:**
  - estado actual en Floci (valor/versión):

    | Flag | dev | test | prod |
    | --- | --- | --- | --- |
    | `ENABLE_DYNAMIC_SURGE_PRICING` | True/3 | True/1 | False/1 |
    | `ENABLE_FAST_CHARGE_BOOST` | True/1 | False/1 | False/1 |
    | `SIMULATE_CHARGER_HARDWARE_FAULT` | False/3 | True/1 | False/1 |

  - **En vivo (§6.4):** el administrador activó la falla en `dev` por GraphQL (versión 2), **sin redesplegar**. El comportamiento cambió de inmediato (`COMPENSATED`) y **`prod` siguió en `False/1`**. Al apagarla (versión 3), la siguiente reserva fue `COMPLETED`.
  - **Prueba de integración** `feature-flags-isolation.int.test.ts`: un cambio en un ambiente no se ve en otro.
- **Comando:** demostración `23-live-flag-saga.log`; `REQUIRE_INTEGRATION=true pnpm test:integration`.
- **Limitación:** Floci no evalúa IAM. El aislamiento se basa en una tabla por ambiente y en `APP_ENV`; el aislamiento por rol IAM solo aplicaría en AWS real (L-08).

## 9. DynamoDB *database-per-service* (§2.4) — Implementado

- **Ubicación:**
  - módulo `infra/terraform/modules/dynamodb-table`;
  - `infra/terraform/live/main.tf` (`local.tables`): `aegisvolt-{reservations,billing,dispatch,sagas,feature-flags}-<env>`, con los nombres de §2.4;
  - un rol IAM por servicio, limitado a su tabla (módulo `iam`).
- **Evidencia:**
  - `terraform-evidence.sh`: **15 tablas, 5 por ambiente, sin nombres repetidos**; el estado de cada workspace solo referencia sus propias tablas;
  - el plan de los 3 workspaces no tiene cambios;
  - los datos de `dev` (SAGAs, movimientos) se conservaron al adoptar las tablas en Terraform.
- **Comando:** `scripts/floci/terraform-evidence.sh`; `scripts/floci/terraform-live.sh <env> plan`.
- **Limitación:** las políticas IAM por tabla no se aplican en Floci (L-08).

## 10. Terraform y módulos (§2.4) — Implementado con limitación

- **Ubicación:**
  - raíces `infra/terraform/{bootstrap,global,live}`;
  - módulos `dynamodb-table`, `network`, `iam`, `eks`, `api-gateway`, `cloudwatch` y `ecr`.
- **Evidencia:**
  - `fmt -check` y `validate` OK;
  - el plan de las 5 raíces sale **sin cambios** frente a lo desplegado en Floci;
  - en GitHub, `terraform-plan` corre en cada PR y `deploy` aplica en un Floci temporal.
- **Comando:** `scripts/ci/terraform-static-checks.sh`; los planes de la tabla de ejecución.
- **Limitación:**
  - **Cognito** (User Pool, cliente, grupos) lo crea un script, no Terraform (L-13): es lo único de la infraestructura fuera de Terraform;
  - el provider avisa sobre `protocol_version` en el target group (atributo devuelto por Floci).

## 11. Workspaces `dev`, `test`, `prod` (§2.4, §6.1) — Implementado

- **Ubicación:**
  - `infra/terraform/live`: `local.environment = terraform.workspace` y nombres con el ambiente;
  - `envs/<env>.tfvars`, con una precondición que exige que coincida con el workspace.
- **Evidencia (`terraform-evidence.sh`, esta corrida):**
  - claves `env:/{dev,test,prod}/aegisvolt/terraform.tfstate` con **3 lineages distintos**;
  - **un apply en `test` creó una versión nueva solo del estado de `test`; las de `dev` y `prod` no cambiaron** (respuesta a §6.1);
  - se rechazan `envs/prod.tfvars` en el workspace `test`, el workspace `default`, un endpoint real de AWS y una cuenta no permitida.
- **Comando:** `scripts/floci/terraform-evidence.sh`.
- **Limitación:** ninguna. Floci tiene una sola cuenta, así que en AWS real se añadiría una cuenta por ambiente (`allowed_account_ids`).

## 12. Backend S3, versionado y bloqueo (§2.4, §6.1) — Implementado con limitación

- **Ubicación:**
  - `infra/terraform/bootstrap`: bucket con versionado, SSE-S3, *public access block*, `BucketOwnerEnforced`, política y retención de versiones;
  - `config/floci/backend.hcl` con `use_lockfile = true`.
- **Evidencia (esta corrida):**
  - el estado de `dev` tiene **49 versiones**;
  - la anterior a la actual se descarga y `terraform show` la lee como estado válido;
  - **bloqueo:** un segundo proceso recibe `Error acquiring the state lock` (412 de S3) y el `.tflock` se libera al terminar;
  - el smoke test recupera una versión previa del estado.
- **Comando:** `scripts/floci/terraform-evidence.sh`. Procedimiento de restauración en [terraform.md](runbooks/terraform.md).
- **Limitación:**
  - la política del bucket se guarda pero Floci no la evalúa (L-12);
  - el cifrado es SSE-S3 y no una CMK de KMS, riesgo aceptado AWS-0132 en `.trivyignore.yaml`, que vence el 2027-05-16. El intento con KMS se revirtió porque Floci no aplica el SSE-KMS por defecto.

## 13. VPC, subredes, rutas y security groups (§2.4) — No verificable con Floci

- **Ubicación:** módulo `infra/terraform/modules/network`:
  - VPC por ambiente (10.10, 10.20 y 10.30) y 2 subredes públicas más 2 privadas;
  - IGW y NAT (uno compartido en dev/test, uno por AZ en prod), y tablas de rutas;
  - SG de VPCE, del NLB y la regla del clúster.
- **Evidencia:** `network-verify.sh dev` (29/29 en esta corrida, `audit-20261119/30-network-verify-dev.md`) confirma con la API de Floci que todo existe con la configuración declarada:
  - CIDR, subredes y rutas (pública → IGW, privadas → NAT);
  - reglas de SG (NLB sin entrada, VPCE 443 solo desde las subredes privadas);
  - CIDR distintos por ambiente (`terraform-evidence.sh`).
- **Comando:** `scripts/floci/network-verify.sh <env>`.
- **Limitación:** **Floci guarda la red como metadatos.** No enruta paquetes, el NAT no traduce, los SG no filtran y los Gateway VPCE no crean rutas de *prefix list* (0 rutas; L-01 y L-14). La configuración es la correcta para AWS, pero el aislamiento no se puede demostrar aquí. El aislamiento real del entorno local lo dan las NetworkPolicies de Kubernetes (requisito 3).

## 14. VPC Endpoints y conectividad API Gateway (§2.4, §6.1) — Parcial

- **Ubicación:**
  - módulo `network`: VPCE Gateway S3 y DynamoDB; Interface `logs`, `monitoring`, `ecr.api`, `ecr.dkr`, `execute-api` y `eks-auth`;
  - módulo `api-gateway`: API REST REGIONAL y PRIVATE, VPC Link V1, NLB interno;
  - [ADR-0034](adr/0034-red-eks-api-gateway-terraform-floci.md).
- **Evidencia:**
  - **funcional (emulado):** `POST https://<id>.execute-api.localhost.floci.io:4566/dev/graphql` → 200 con TLS verificado, a través de API Gateway → VPC Link → NLB → Traefik → pod (`network-verify.sh`);
  - los 8 VPCE están `available`, con ENI y DNS sintetizados;
  - la API PRIVATE está asociada al VPCE `execute-api`, con una política `aws:SourceVpce`.
- **Comando:** `scripts/floci/network-verify.sh dev`.
- **Limitación (por eso "parcial"):**
  - la API PRIVATE **responde 200 desde fuera de la VPC**: Floci no aplica su política (L-02);
  - los VPCE no enrutan (L-01);
  - el "VPCE hacia Kubernetes" de §2.4 se resuelve con el endpoint privado del API server de EKS, que Floci guarda pero no aplica (L-03);
  - API Gateway no escribe sus logs de acceso en Floci (L-14).

## 15. CloudWatch Logs y métricas (§2.5, §6.4) — Implementado con limitación

- **Ubicación:**
  - logs JSON con `correlation_id`, `saga_id`, `environment` y `service_name` ([ADR-0028](adr/0028-logging-estructurado-operation-errores-tipados.md));
  - Fluent Bit en el clúster;
  - módulo `cloudwatch`: log groups `/aegisvolt/<env>/<servicio>`, metric filters, alarmas y dashboard.
- **Evidencia:**
  - **8 log groups por ambiente**, con retención de 7, 14 y 30 días y 7 alarmas por ambiente;
  - métricas en `AegisVolt/dev`: `SagaCompleted`, `SagaCompensated`, `SagaFailed`, `SagaCompensationFailed`, `SagaDuration`, `ServiceErrors`, `Http5xx`, `GraphqlOperations` y `GraphqlServerErrors`;
  - **en vivo (§6.4):** el `correlation_id` de la SAGA fallida aparece en los **5** log groups de `dev`, y en el orquestador se ve la secuencia `SAGA_STARTED` → `STEP_FAILED` → `COMPENSATION_*` → `SAGA_COMPENSATED`;
  - `k8s-verify.sh`: 6/6 servicios con logs y la métrica `SagaCompleted` con suma ≥ 1.
- **Comando:** `scripts/floci/k8s-verify.sh dev`; `aws logs filter-log-events --filter-pattern '"<correlation_id>"'`.
- **Limitación:**
  - Logs Insights `stats` y EMF no funcionan en Floci (L-09);
  - los logs de acceso de API Gateway no se emiten (L-14).

## 16. Prefect flows y tasks (§2.5, §6.4) — Implementado con limitación

- **Ubicación:** `prefect/src/aegisvolt_observability/flows/`:
  - `environment_health_monitor`;
  - `saga_consistency_audit`;
  - `reservation_consistency_audit`;
  - `billing_consistency_audit`.

  Son de solo lectura por las APIs de los servicios ([ADR-0030](adr/0030-prefect-auditoria-solo-lectura-por-apis.md)).
- **Evidencia (esta corrida):**
  - `ruff`, `mypy` estricto y **25** pruebas con fixtures;
  - **en vivo contra el clúster `dev`**, con un servidor Prefect temporal:
    - `environment_health_monitor`: 15 tareas completadas. Reporta `dev=OPERATIONAL`, `test=DOWN` y `prod=DOWN`, y termina en `Failed` **por diseño**: en local `test` y `prod` no tienen clúster;
    - `saga_consistency_audit(dev)`: tareas por cada estado de SAGA, **0 hallazgos y 0 errores**, y 7 métricas publicadas en `AegisVolt/Audit`.
- **Comando:** `AEGISVOLT_AUDIT_CONFIG=<config> .venv/bin/python -c "from aegisvolt_observability.flows import saga_consistency_audit as f; f(environment='dev')"`. Logs en `24-prefect-live.log` y `25-prefect-saga-audit.log`.
- **Limitación:**
  - el repositorio no trae una configuración que apunte al clúster: para esta prueba se usó una temporal (servicios por `port-forward`);
  - el dashboard de Prefect no se dejó corriendo; se usó un servidor efímero.

## 17. Git flow y protección de ramas (§3.1, §3.2, §6.2) — Implementado con limitación

- **Ubicación:**
  - rulesets de GitHub `protect-dev`, `protect-test` y `protect-prod` (configuración manual: [github-repository-settings.md](runbooks/github-repository-settings.md));
  - `scripts/ci/promotion-guard.sh`, con pruebas.
- **Evidencia (API pública de GitHub, esta corrida):**
  - las 3 ramas tienen `deletion`, `non_fast_forward` (bloquea el force push) y `pull_request` (bloquea el push directo);
  - método de merge: `squash` en `dev` y `merge` en `test` y `prod`;
  - historial de promoción: 13 PR hacia `dev` (10 `feature/*` y 3 `fix/*`), los #15 y #20 `dev → test` y el #21 `test → prod`;
  - `promotion-guard` rechaza `feature → test`, `dev → prod`, ramas de forks, etc.
- **Comando:** `curl https://api.github.com/repos/<owner>/aegisvolt/rules/branches/<rama>`; `scripts/ci/promotion-guard.test.sh`.
- **Corregido después de la auditoría:** `terraform-plan` se había quitado de los checks obligatorios de `dev` para fusionar el PR #18. El propietario lo volvió a agregar, y la API pública confirma que `protect-dev` exige 20 checks, incluido `terraform-plan`. Las tres ramas cumplen ahora §3.1.3.
- **No verificado en esta auditoría:** el rechazo de un `git push --force` o de un push directo (`GH013`, §6.2). Las reglas están activas según la API, pero la prueba requiere un push, que esta auditoría no ejecuta.

## 18. CI/CD, `terraform plan` y `apply` (§3.3, §6.2) — Implementado con limitación

- **Ubicación:**
  - `.github/workflows/`: `ci.yml` (12 jobs y la puerta `ci-result`), `terraform-plan.yml`, `deploy-floci.yml`, `canary-deployment.yml` y `security.yml`;
  - lógica en `scripts/ci/`; [ADR-0035](adr/0035-cicd-github-actions-runners-hospedados-floci-efimero.md).
- **Evidencia:**
  - en GitHub, la última ejecución de `deploy-floci` y `security` terminó en **success** en `dev` (`4e6e269`), `test` (`9626f5e`) y `prod` (`077be0d`);
  - el ambiente se detecta por la rama (`scripts/ci/resolve-environment.sh`, §6.2), y el plan del PR usa el workspace de la rama destino;
  - el post-merge regenera el plan, rechaza destrucciones y aplica ese plan.
- **Comando:** API `actions/runs?branch=<rama>`; lectura de `deploy-floci.yml` y `resolve-environment.sh`.
- **Limitación:**
  - con repositorio público, GitHub Free y solo runners hospedados, el `apply` post-merge se ejecuta en un **Floci temporal del runner**, no en un ambiente persistente; el Floci del autor se despliega a mano (L-15);
  - el plan del PR reconstruye el estado aplicando la rama destino;
  - el deploy de `prod` necesitó 3 intentos (requisito 5).

## 19. Canary y rollback (§3.3, §6.2) — Implementado con limitación

- **Ubicación:**
  - `infra/k8s/components/canary`: `Rollout` 20 % → análisis → 50 % → análisis → 100 %, `TraefikService` con pesos y `AnalysisTemplate` con disponibilidad ≥ 11/12 y errores ≤ 2 % con ≥ 30 operaciones, leídos de CloudWatch;
  - [ADR-0032](adr/0032-canary-argo-rollouts-traefik-cloudwatch.md).
- **Evidencia (esta corrida, `dev`):**

  Tráfico medido en cada respuesta (cabecera `x-service-version`), no inferido del número de pods:

  | Escenario | Pesos (estable/canary) | Respuestas | Estable | Canary | Errores canary | Desenlace |
  | --- | --- | --- | --- | --- | --- | --- |
  | Promoción (versión sana) | 80/20 | 754 | 78,1 % | 21,9 % | 0 | |
  | | 50/50 | 728 | 49,2 % | 50,8 % | 0 | |
  | | 100/0 tras promover | 388 | 0 % | 100 % | 0 | **Promoted** |
  | Rollback (`STATION_RESERVATION_URL` incorrecta) | 80/20 | 239 | 82,8 % | 17,2 % | 41 | |
  | | 100/0 tras el abort | 330 | **100 %** | 0 % | 0 | **Aborted** |

  - En el rollback, Argo abortó por `Metric "error-rate" assessed Failed due to failed (2) > failureLimit (1)`: el tráfico volvió al 100 % a la versión estable y se restauró la plantilla.
  - Estado final: Rollout `Healthy`, pesos 100/0.
  - Informes: `audit-20261119/27-canary-success-report.md` y `28-canary-failure-report.md`.

- **GitHub:** el canary se ejecutó y promovió en `dev` y `test` (sin aviso de "no ejecutado"). En `prod` **no se ejecutó**: su línea base (`first-commit`) no tenía canary.
- **Respuesta a §6.2:** el `AnalysisTemplate` mide la disponibilidad (`/health/ready` del canary) y la tasa de error del servidor por versión, leída de CloudWatch con el proveedor nativo de Argo. Con menos de 30 operaciones no promueve.
- **Comando:** `scripts/floci/canary-demo.sh dev success` y `scripts/floci/canary-demo.sh dev failure`.
- **Limitación:**
  - solo graphql-api tiene canary: los servicios internos se llaman este-oeste y repartirlos por peso exigiría una malla de servicios;
  - `prod` no tiene evidencia propia de canary en GitHub.

## 20. Seguridad y gestión de secretos — Implementado con limitación

- **Ubicación:**
  - `.gitignore` (estado, planes, `.env` y datos de Floci);
  - credenciales ficticias `test` en los `config/floci`;
  - el provider sin `~/.aws` (`shared_*_files = /dev/null`) y validación de endpoints locales;
  - `security.yml`: dependency review, `pnpm audit`, Gitleaks, CodeQL y Trivy;
  - `.gitleaks.toml` y `.trivyignore.yaml`.
- **Evidencia:**
  - barrido de esta corrida: **0** coincidencias de claves de AWS, claves privadas o tokens en los archivos versionados; solo se versionan `.env.example`;
  - `terraform-evidence.sh` rechaza endpoints reales y cuentas no permitidas;
  - en GitHub, `security` termina en **success** en las 3 ramas;
  - en el clúster: contenedores no root, solo lectura, PSA `restricted` y NetworkPolicies *default-deny*.
- **Comando:** `scripts/floci/k8s-verify.sh dev`; el barrido en `audit-20261119/secrets-scan.txt`.
- **Limitación:**
  - **3 riesgos de configuración aceptados** en `.trivyignore.yaml`, que vencen el 2027-05-16: KSV-0118 (Fluent Bit sin *security context* de pod), AWS-0132 (bucket de estado sin CMK) y AWS-0039 (EKS sin cifrado de Secrets con KMS). El intento de corregirlos se revirtió porque Floci no lo soporta;
  - 4 claves de idempotencia de prueba excluidas de Gitleaks (`.gitleaks.toml`);
  - Gitleaks y Trivy solo se ejecutaron en CI: localmente no se pudieron correr los binarios.

---

## Hallazgos y pendientes de la auditoría

| # | Hallazgo | Impacto | Acción |
| --- | --- | --- | --- |
| 1 | `terraform-plan` no era obligatorio en `dev` | Incumplía §3.1.3 en `dev` | **Corregido**: re-agregado por el propietario y verificado por la API |
| 2 | El rechazo de force push o push directo no se demostró en esta auditoría | §6.2 sin evidencia propia | Propietario: ejecutar el procedimiento seguro de la [guía de sustentación §6.2.1](guia-sustentacion.md#621-intente-hacer-un-git-push---force-o-un-push-directo-a-la-rama-test-desde-su-terminal-y-muestre-qué-regla-del-repositorio-lo-bloquea) |
| 3 | `k8s-verify.sh` y `canary-demo.sh` dejan `port-forward` abiertos al terminar | Puertos ocupados; no afecta resultados | Corregir el cierre (lanzar `kubectl` sin subshell). Documentado como [L-20](limitations.md#l-20--los-scripts-de-verificación-dejan-port-forward-abiertos) |
| 4 | Arranque intermitente de k3s en CI (`prod`, 3 intentos) | Reintentos manuales | Añadir los logs del contenedor k3s al diagnóstico y fallar con un mensaje claro. Documentado como [L-19](limitations.md#l-19--arranque-intermitente-de-k3s-en-los-runners-de-github) |
| 5 | Canary sin evidencia en `prod` | Solo `dev` y `test` | Se tendrá en la próxima promoción `test → prod`. Documentado en L-15 |
| 6 | El runbook de configuración de GitHub pide *Require branches to be up to date* también en `test`/`prod` y no advierte que *Require linear history* es incompatible con los merge commits | Así configurado, bloquea la segunda promoción | **Corregido** en el runbook (§2 y §9) |
| 7 | Prefect no trae una configuración para el clúster | La prueba en vivo usó una configuración temporal | Añadir `config/k8s.toml`. Documentado como [L-18](limitations.md#l-18--prefect-no-trae-configuración-para-el-clúster); procedimiento en [observability.md §6.1](runbooks/observability.md#61-contra-el-clúster-dev-de-floci) |
| 8 | Cognito fuera de Terraform (L-13) | §2.4 "toda la infraestructura en Terraform" | Módulo `identity` (pendiente) |
| 9 | El "Motivo" del informe de `canary-demo.sh` puede citar un AnalysisRun de una ejecución anterior | El informe de rollback puede mostrar un motivo que no corresponde | Filtrar los AnalysisRuns por el hash del canary de esta ejecución |
