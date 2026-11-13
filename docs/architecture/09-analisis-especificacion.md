# 09 · Análisis crítico de `proyecto_final.md`

Contradicciones, ambigüedades y requisitos técnicamente problemáticos, cada uno con una propuesta. **Ningún requisito se elimina:** cuando la propuesta interpreta o complementa la especificación, se dice explícitamente y queda registrado en un ADR.

Estados:
- **Resuelto (ADR):** la propuesta está decidida.
- **Requiere confirmación:** decisión del autor o consulta al profesor.
- **Riesgo:** debe verificarse al implementar.

## Red e infraestructura

| ID | Referencia | Hallazgo | Tipo | Propuesta | Estado |
| --- | --- | --- | --- | --- | --- |
| P-01 | §2, diagrama: "API GATEWAY → (VPC Endpoint Privado) → EKS" | Técnicamente incorrecto. Un VPC Endpoint permite que clientes **dentro** de la VPC lleguen a un servicio AWS; API Gateway alcanza backends privados mediante **VPC Link** hacia un NLB/ALB. | Contradicción técnica | API Gateway → VPC Link → NLB interno → pods. El VPCE `execute-api` se usa para la API PRIVATE (`/ops`) consumida desde la VPC. | Resuelto ([ADR-0010](../adr/0010-red-apigw-vpc-link-nlb-y-vpce.md)) |
| P-02 | §2.4: "VPCE … hacia los servicios en el clúster de Kubernetes" | Ambiguo. Puede significar el endpoint privado del API server (que no es PrivateLink), el Interface VPCE `eks` (que **solo** cubre la API de gestión de EKS) o un *VPC endpoint service* (PrivateLink) delante del NLB. | Ambigüedad | Endpoint privado del API server + Interface VPCE `eks` + NLB interno con VPC Link. Un *endpoint service* PrivateLink sobre el NLB queda como opción si el profesor lo exige (solo tiene sentido para consumidores de **otra** VPC). | Requiere confirmación (profesor) |
| P-03 | §2.4 VPCE hacia API Gateway + §2.1 frontend web | Si la única API fuera PRIVATE, el navegador del operador (en Internet) no podría usarla. | Contradicción | Dos APIs: REST Regional pública para el frontend y REST PRIVATE para operaciones y observabilidad, accesible solo por el VPCE `execute-api`. | Resuelto (ADR-0010) |
| P-25 | §5.2, 30 % IaC: VPC/VPCE "arquitectura de red privada" | En Floci, VPC, rutas, VPCE y API PRIVATE son **solo metadatos** o no aplican aislamiento (verificado); el endpoint EKS privado no se aplica. | Limitación del entorno | Demostrar: (a) la declaración completa en Terraform y su estado vía `describe-*`; (b) la cadena funcional API Gateway → VPC Link → NLB → k3s → pod (verificada); (c) aislamiento real con NetworkPolicies; (d) documentación del recorrido del paquete. No se simula lo que Floci no hace. | Resuelto ([04](04-networking.md), [limitations](../limitations.md)) |
| P-28 | §1.2 aislamiento multi-ambiente | Floci usa una sola cuenta (`000000000000`) para los tres ambientes; en AWS se recomendaría una cuenta por ambiente. | Limitación | Aislamiento por estado, nombres, tablas, VPC, clúster y User Pool por ambiente. Se documenta la recomendación multi-cuenta. | Resuelto ([ADR-0011](../adr/0011-terraform-workspaces-backend-s3-bootstrap.md)) |
| P-06 | §2.4 Workspaces obligatorios | La documentación de Terraform dice que los workspaces "are not a suitable isolation mechanism" cuando se necesitan credenciales y controles separados. | Problema técnico | Se cumple el requisito y se mitiga: precondición de workspace, nombres derivados, `prevent_destroy` y `deletion_protection` en `prod`, workspace derivado de la rama en CI. | Resuelto (ADR-0011) |
| P-29 | §2.4 "tfstate en S3" | El bucket de estado no puede gestionarse con el mismo estado que almacena. | Problema técnico | Módulo `bootstrap/` con estado inicial local, migrado luego al bucket (`-migrate-state`). | Resuelto (ADR-0011) |
| P-07 | §3.3 `terraform apply -auto-approve` post-merge | En `prod` real se suele exigir aprobación manual del plan. | Riesgo de diseño | Se cumple como está: el PR ya exigió un `plan` en verde. El `apply` vuelve a planificar sobre el estado actual, con `concurrency` por ambiente y *lockfile*. En AWS real se recomendaría un *environment* con revisores. | Resuelto ([ADR-0015](../adr/0015-cicd-github-actions-hibrido-y-promocion.md)) |

## Backend, SAGA y flags

| ID | Referencia | Hallazgo | Tipo | Propuesta | Estado |
| --- | --- | --- | --- | --- | --- |
| P-04 | §2, diagrama "HTTPS / WSS"; §2.1 "en tiempo real" | API Gateway REST no actúa como proxy transparente de WebSocket hacia un backend GraphQL (la API WebSocket es otro tipo de API, con rutas por mensaje). La página oficial no cargó durante la revisión, así que la afirmación debe re-verificarse. | Ambigüedad / problema técnico | "Tiempo real" se implementa con **polling** (2–5 s) de queries GraphQL a través de la API REST. WSS queda fuera de alcance y se documenta. | Resuelto ([ADR-0017](../adr/0017-frontend-spa-mismo-origen-polling.md)); re-verificar |
| P-08 | §1.2 "autorizar retenciones de saldo" frente a §2.3 "descuenta el saldo estimado" | Retención (autorizar y luego capturar) frente a débito inmediato. | Contradicción menor | Se sigue §2.3, que es el requisito operativo: **débito** del cargo estimado; la compensación es un reembolso. La liquidación final por consumo real queda fuera de alcance. | Resuelto ([ADR-0003](../adr/0003-saga-orquestada-maquina-estados-persistente.md)) |
| P-09 | §2.3.4 compensación del paso 3: reembolso → liberación | Si la activación hace *timeout*, el cargador pudo activarse sin que el orquestador lo sepa. Reembolsar y liberar dejaría una carga activa sin cobro y un conector "libre" ocupado. | Problema técnico | Se añade, **antes** del reembolso, `abort` de la sesión (idempotente, con tombstone) y una consulta del estado de la sesión en el pivote. El orden pedido (billing y luego reservation) se mantiene. | Resuelto (ADR-0003) |
| P-10 | §2.3 estados `RESERVED`/`AVAILABLE` | No se especifica cuándo se libera un conector tras una carga **exitosa**. | Ambigüedad | La reserva pasa a `CONFIRMED` al completar la SAGA. El fin de la carga (`completeChargingSession`) queda como extensión opcional; para la demo hay un reseteo administrativo de datos semilla. | Requiere confirmación (alcance) |
| P-11 | §2.2 "bloqueo temporal de bahías" | No se define la duración ni el vencimiento. | Ambigüedad | *Hold* de 120 s con vencimiento perezoso, confirmado al completar la SAGA. Sirve también de red de seguridad si el orquestador cae. | Resuelto ([ADR-0006](../adr/0006-dynamodb-single-table-por-servicio.md)) |
| P-12 | §2.2 "Mutations para iniciar reservas, pagos y sesiones de carga" | Mutaciones separadas permitirían saltarse la SAGA. | Ambigüedad | Una mutación `reserveAndStartCharging` que dispara la SAGA (cubre reserva, pago y sesión) + `topUpWallet` (pagos) + `setFeatureFlag` (admin). No se exponen pasos sueltos. | Resuelto ([01](01-dominio-y-servicios.md)) |
| P-13 | §2.2 flags con valores distintos por ambiente + §2.4 "todo en Terraform" | Si Terraform gestiona el valor de la flag, el siguiente `apply` revierte el cambio hecho "sin redesplegar" (§6.4). | Contradicción técnica | Terraform crea la tabla y **siembra** los valores por ambiente con `ignore_changes`; el estado en caliente lo gestiona la mutación admin y queda auditado. | Resuelto ([ADR-0007](../adr/0007-feature-flags-dynamodb-por-ambiente.md)) |
| P-14 | §2.2 `ENABLE_FAST_CHARGE_BOOST`: "reserva prioritaria de ultra-carga" | Semántica no definida: ¿prioridad sobre quién? ¿qué se bloquea si está apagada? | Ambigüedad | Si está activa, las reservas `fastChargeBoost` pueden tomar conectores `ultraFast` con *hold* extendido; si no, responden `403 FAST_CHARGE_BOOST_DISABLED`. | Requiere confirmación (profesor) |
| P-15 | §2.2 `SIMULATE_CHARGER_HARDWARE_FAULT` en todos los ambientes | Un interruptor de inyección de fallos en `prod` es un riesgo operativo. | Riesgo | Existe en `prod` (lo exige el aislamiento por ambiente) con valor `false`, solo administrable por `platform-admins` y con auditoría. La demo de §6.3 usa `test`. | Resuelto (ADR-0007) |
| P-17 | §2.2 "mínimo tres microservicios"; diagrama con 3 servicios | No define dónde vive el orquestador. Ponerlo en los resolvers violaría "sin lógica de negocio en resolvers" (CLAUDE.md). | Ambigüedad | Cuarto servicio `saga-orchestrator-service`, compatible con "mínimo tres". | Resuelto ([ADR-0002](../adr/0002-bounded-contexts-y-orquestador-dedicado.md)) |
| P-27 | §1.2 "telemetría en tiempo real" | No hay hardware real. | Limitación | Telemetría simulada por el adaptador `SimulatedChargerGateway`. | Resuelto |

## Observabilidad y datos

| ID | Referencia | Hallazgo | Tipo | Propuesta | Estado |
| --- | --- | --- | --- | --- | --- |
| P-16 | §3.3 canary 10–20 % + "métricas de error en CloudWatch" | Sin *traffic router*, el porcentaje es por réplicas: con 2 réplicas el canary es del 50 %. Floci no soporta *metric math* ni `stats` en Insights. | Problema técnico | Argo Rollouts por réplicas: 5 réplicas en `prod` (20 % exacto), 2 en `dev` (50 %, documentado). La tasa de error se calcula en un Job de análisis a partir de CloudWatch Logs. | Resuelto ([ADR-0013](../adr/0013-canary-argo-rollouts-analisis-cloudwatch.md)) |
| P-18 | §2.4 "uso exclusivo de DynamoDB" frente a §2.5 Prefect | Prefect Server necesita su propia base de metadatos. | Contradicción aparente | "Exclusivo" se interpreta como datos de negocio de AegisVolt. La BD interna de Prefect es infraestructura de la herramienta. | Resuelto ([ADR-0014](../adr/0014-observabilidad-cloudwatch-fluent-bit-prefect.md)) |
| P-19 | §2.5 Prefect "audite … en DynamoDB" frente a Database-per-Service | Prefect lee las tablas de todos los servicios. | Tensión de diseño | Excepción explícita de **solo lectura** para auditoría (rol IAM de lectura); Prefect nunca escribe ni repara. | Resuelto (ADR-0014) |

## Git y CI/CD

| ID | Referencia | Hallazgo | Tipo | Propuesta | Estado |
| --- | --- | --- | --- | --- | --- |
| P-20 | §3.3 apply y deploy post-merge en `dev`/`test`/`prod` con Floci | Un runner hospedado por GitHub no alcanza el Floci local, y un Floci efímero no conservaría los ambientes. | Problema técnico | Runner **self-hosted** en el equipo con Floci para plan, apply y deploy; runners hospedados con Floci efímero para lint, unit, integration y e2e. | Resuelto (ADR-0015) |
| P-21 | §3.1 protección de ramas | En GitHub Free, la protección de ramas y los *environments* solo están disponibles en repos **públicos**; y GitHub desaconseja self-hosted runners en repos públicos. | Conflicto de restricciones | **Opción A (recomendada):** repo público con mitigaciones del runner (solo `push` a ramas protegidas y PRs del mismo repo, aprobación para externos, runner efímero, sin credenciales reales). **Opción B:** repo privado con GitHub Pro. | **Requiere confirmación (autor)** |
| P-22 | §3.1 "`dev` (o `develop`), `test` y `prod`" | El repositorio actual solo tiene `main`. | Ambigüedad | Ramas `dev`, `test` y `prod`; `dev` como rama por defecto. `main` se archiva o se elimina, **solo con autorización**. | **Requiere confirmación (autor)** |
| P-23 | §3.1.2 PR obligatorio en un proyecto individual | Un autor no puede aprobar su propio PR. | Problema práctico | PR obligatorio con 0 aprobaciones y checks obligatorios, sin bypass. | Resuelto (ADR-0015) |
| P-24 | §3.2 "evitar conflictos de historial" | Si las promociones se fusionan con *squash* o *rebase*, `test` y `prod` divergen de `dev` y aparecen conflictos. | Problema técnico | `dev→test` y `test→prod` siempre con **merge commit**; *squash* solo en `feature→dev`. | Resuelto (ADR-0015) |
| P-30 | §3.2 origen obligatorio de los PR | Las reglas nativas revisadas no restringen la rama **origen**. | Limitación de la plataforma | Check obligatorio `promotion-guard`. | Resuelto (ADR-0015) |
| P-26 | §3.3 E2E en cada PR | Es costoso en tiempo. | Riesgo | E2E con `docker compose` (Floci efímero + apps + SPA) en un runner hospedado; sin k3s en el PR. Los smoke y el canary sobre K8s ocurren post-merge. | Resuelto ([ADR-0016](../adr/0016-estrategia-de-pruebas.md)) |

## Forma del documento

| ID | Referencia | Hallazgo | Propuesta |
| --- | --- | --- | --- |
| P-05 | Numeración; línea 103 | Falta la sección **4** (de §3 salta a §5); quizá contenía los entregables. La línea 103 tiene un artefacto de formato (`\|---\|\*`). No se pierde ningún requisito legible. | Preguntar al profesor si existe una sección 4 (entregables o fechas). **Requiere confirmación.** |

## Riesgos que deben verificarse al implementar

| ID | Riesgo | Mitigación / verificación |
| --- | --- | --- |
| R-01 | Cambios de comportamiento entre versiones de Floci | Imagen fijada en `2.4.0`; smoke tests antes de actualizar |
| R-02 | Memoria: tres clústeres k3s + 6 apps × réplicas en un equipo de 7,5 GB | Medir en la fase de K8s. `prod` bajo demanda para la demo y límites de recursos ajustados |
| R-03 | Funciones no verificadas aún en Floci: endpoint de Fluent Bit hacia Floci, patrones JSON en `FilterLogEvents`, *Cognito authorizer* en API Gateway, `aws_eks_cluster` y `aws_lb*` vía Terraform, IRSA/Pod Identity, NetworkPolicies de k3s, ECR `PutImage` para promover digests | Verificar en cada fase antes de depender de ellas; las alternativas están documentadas en los ADR |
| R-04 | Seguridad del runner self-hosted | Mitigaciones de P-21 |
| R-05 | Alcance amplio para 14 días | Priorizar según el peso de la rúbrica: IaC (30 %) y CI/CD (25 %) antes que refinamientos del frontend |

Verificado en esta fase: `TransactWriteItems` atómico con condiciones, PITR, `deletion_protection`, la cadena VPC Link → NLB → k3s, Cognito con JWT/JWKS y las métricas de CloudWatch.
