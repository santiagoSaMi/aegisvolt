# Limitaciones conocidas del entorno local (Floci)

Verificadas con **Floci 2.4.0** el 2026-11-12. La evidencia está en [`infra/local/floci/README.md`](../infra/local/floci/README.md#matriz-de-servicios).

Cada limitación indica el requisito afectado de `proyecto_final.md` y la propuesta para cumplir el objetivo académico de forma **verificable**, sin simular que funciona. Las propuestas se concretarán en las fases correspondientes.

## L-01 · VPC Endpoints y networking privado son solo metadatos

- **Requisito:** §2.4 — VPC dedicada con subredes públicas y privadas por ambiente; VPCE hacia API Gateway y Kubernetes; Gateway/Interface VPCE para S3, DynamoDB y CloudWatch, "evitando que el tráfico interno salga a la internet pública".
- **Comportamiento observado:**
  - VPC, subnets, route tables y VPCE (Interface y Gateway) se crean y quedan `available`, con ENI y DNS sintetizados.
  - El Gateway VPCE **no añade rutas** de prefix list a la tabla de rutas.
  - El tráfico no atraviesa ninguna VPC.
- **Propuesta verificable:**
  - Declarar toda la red en Terraform (VPC, subredes, tablas de rutas, security groups, VPCE con sus políticas) y aplicarla en Floci; se verifica con `terraform plan/apply` y `aws ec2 describe-*` por ambiente.
  - Documentar el recorrido del paquete (API Gateway → **VPC Link → NLB interno** → pod) con un diagrama y las reglas que intervienen. Una corrección respecto a la versión anterior de este documento: un VPCE **no** conecta API Gateway con los pods ([04-networking.md](architecture/04-networking.md)).
  - Indicar en la sustentación que en Floci el aislamiento es declarativo, no enforced.
- **Lo que sí funciona** (verificado en la fase de arquitectura, 2026-11-12):
  - El **data plane del NLB** (ELBv2): Floci levanta el listener dentro de su contenedor (`floci:<puerto>`) y reenvía a *targets* `ip`.
  - **VPC Link** (REST): `AVAILABLE`, y la integración `HTTP_PROXY` + `VPC_LINK` se ejecuta.
  - La cadena **API Gateway → VPC Link → NLB → NodePort k3s → pod** respondió 200.
  - Diferencia con AWS: el DNS del NLB (`*.elb.floci`) no resuelve, por lo que el URI de integración local es `http://floci:<puerto>`.

- **Con Terraform** (2026-11-15, módulo `network`, ADR-0033): en los tres ambientes se crean la VPC, 4 subredes, IGW, NAT, las tablas de rutas, 2 VPCE Gateway y 9 Interface, todos `available`. Las rutas de prefix list de los Gateway VPCE siguen sin aparecer en las tablas privadas.

## L-02 · API Gateway `PRIVATE` no aplica aislamiento

- **Requisito:** §2.4 — conexión privada hacia los endpoints de API Gateway.
- **Comportamiento observado:**
  - Una REST API `PRIVATE` asociada a un VPCE se crea correctamente, pero responde 200 desde el host, fuera de la VPC.
  - Según la documentación, Floci autentica pero no evalúa `execute-api:Invoke` ni las resource policies.
- **Propuesta verificable:**
  - Declarar la API `PRIVATE` y su resource policy (`aws:SourceVpce`) en Terraform; se verifica con `get-rest-api` y `get-rest-api --query policy`.
  - El aislamiento efectivo en local lo aplicará Kubernetes: Services `ClusterIP` y NetworkPolicies. Esto se verificará en la fase de K8s.

- **Con Terraform** (2026-11-15, módulo `api-gateway`; re-verificado con `network-verify.sh`, que invoca `POST /graphql` de la API PRIVATE desde el host y obtiene 200): Floci 2.4.0 crea la API `PRIVATE`, asociada al VPCE `execute-api` y con su resource policy `aws:SourceVpce`. Esto contradice la documentación de Floci, que dice que la rechaza. También crea el NLB interno, el VPC Link `AVAILABLE` y las integraciones `HTTP_PROXY` por `VPC_LINK`.

## L-03 · EKS es k3s, no EKS administrado

- **Requisito:** §2.2 — microservicios desplegados sobre Kubernetes (diagrama: EKS).
- **Comportamiento observado:**
  - La API de EKS (`create-cluster`, `describe-cluster`, `update-kubeconfig`) funciona y levanta un contenedor k3s v1.36.
  - Todos los node groups comparten un único nodo.
  - No se pueden actualizar la configuración ni la versión del clúster.
  - `test/test` es rechazado; hace falta una access key IAM emitida por Floci.
  - `endpointPrivateAccess=true` / `endpointPublicAccess=false` se almacenan, pero **no se aplican**: `kubectl` sigue accediendo desde el host.
- **Operación verificada** (2026-11-15, k3s v1.36.0+k3s1, [ADR-0031](adr/0031-contenedores-kubernetes-floci.md)):
  - pull de imágenes desde el ECR de Floci;
  - Deployments con rollouts, probes y DNS de Services;
  - **NetworkPolicies aplicadas** (kube-router de k3s): conexiones permitidas y bloqueadas;
  - Pod Security Admission `restricted`;
  - `exec`, `port-forward` y `logs`;
  - una SAGA real de punta a punta;
  - Fluent Bit → CloudWatch;
  - dry-run del lado del servidor de los overlays `test` y `prod`.
- **Lo que NO equivale a EKS administrado:**
  - un solo nodo y sin node groups reales;
  - sin balanceador de Services (`LoadBalancer`), así que la entrada local es `port-forward`;
  - IRSA y Pod Identity sin verificar: los pods usan credenciales ficticias por Secret;
  - las NetworkPolicies las aplica kube-router (en EKS: el *network policy agent* de VPC CNI o Calico);
  - sin actualizaciones gestionadas del plano de control.
  - Las pruebas de carga o de alta disponibilidad no son representativas.
- **Aprovisionamiento con Terraform (verificado el 2026-11-15, [ADR-0033](adr/0033-terraform-modular-backend-s3-floci.md)):**
  - `aws_eks_cluster`, `aws_eks_node_group`, `aws_eks_addon` (`eks-pod-identity-agent`) y `aws_eks_pod_identity_association` se crean contra Floci 2.4.0;
  - el clúster `aegisvolt-dev` queda `ACTIVE` en las subredes privadas de la VPC de `dev`, y la aplicación se despliega y pasa la prueba de humo.
  - Floci no implementa `UpdateClusterConfig` ni `UpdateClusterVersion`: cambiar subredes o versión obliga a recrear el clúster.
  - Las asociaciones de Pod Identity se guardan, pero los pods de Floci siguen usando credenciales ficticias por Secret.

## L-04 · Canary con métricas de CloudWatch

- **Requisito:** §3.3 — health checks y métricas de error en CloudWatch antes de promover del 20 % al 100 %.
- **Estado de CloudWatch en Floci** (verificado el 2026-11-12 y de nuevo con `scripts/floci/cloudwatch-probe.sh` el 2026-11-14):
  - Funcionan `put-metric-data`, `get-metric-statistics`, `get-metric-data` con `MetricStat` y los metric filters de Logs (un log de error genera la métrica).
  - Una expresión de *metric math* (`100*e/r`) **no devolvió resultado**, como anticipaba la documentación.
  - Las alarmas de **una sola métrica** sí se evalúan: pasan a `ALARM` con datos de un metric filter.
- **Lo que sí se verificó con el canary** (2026-11-15, Argo Rollouts v1.10.1, [ADR-0032](adr/0032-canary-argo-rollouts-traefik-cloudwatch.md)):
  - El proveedor `cloudWatch` del núcleo de Argo lee `GetMetricData` del CloudWatch de Floci (`AWS_ENDPOINT_URL` en el controlador).
  - Las mediciones usan métricas reales: logs de graphql-api → Fluent Bit → metric filters de Terraform → métricas por `Version`.
  - Una promoción y un abort reales dependieron de esas mediciones ([runbook](runbooks/canary-rollback.md)).
- **Diferencias y pendientes en AWS real:**
  - La tasa se calcula en la condición del análisis con dos series, porque Floci no tiene *metric math*. En AWS podría usarse una expresión `errors/ops`, pero no hace falta.
  - **Pendiente de validar en AWS real:**
    - credenciales del controlador por IRSA/Pod Identity con `cloudwatch:GetMetricData` (en local, Secret ficticio);
    - la latencia real de los metric filters, que determina el `initialDelay` de 60 s;
    - que CloudWatch devuelva las dos series en el orden de las consultas. La condición comprueba el `Id` y, si cambia el orden, la medición falla en vez de calcular mal.
  - Floci no tiene ALB ni el AWS Load Balancer Controller: el reparto lo hace Traefik dentro del clúster, igual que se haría en EKS detrás de un NLB.
- **Alcance del canary:** solo graphql-api (tráfico norte-sur). Los servicios internos se llaman este-oeste por `ClusterIP`; repartirlos por peso exige una malla de servicios (ADR-0032, alternativa 4).
- **Herramientas:** no se instaló el plugin `kubectl-argo-rollouts`. Se opera con `kubectl` sobre los recursos (`rollout`, `analysisrun`, `traefikservice`) y `kubectl patch` para abortar o promover.

## L-05 · API Gateway HTTP (v2) sin verificar

- **Comportamiento observado:** solo se probó `create-api`.
- **Documentación de Floci:** las integraciones `AWS_PROXY` solo invocan `SQS-SendMessage`. El resumen de la documentación indica que `HTTP_PROXY` está soportado.
- **Pendiente:** decidir entre REST v1 (verificado) y HTTP v2 en un ADR cuando se diseñe la entrada GraphQL.

## L-07 · Los pods de k3s no resuelven el hostname `floci`

- **Comportamiento observado:**
  - CoreDNS reenvía al `resolv.conf` del nodo k3s, que apunta al DNS embebido de Docker y no es alcanzable desde los pods (`nslookup floci` → NXDOMAIN).
  - Los pods sí alcanzan a Floci por IP.
  - El `iss` de los tokens de Cognito usa `https://floci:4566/...` (con `FLOCI_TLS_ENABLED`, ADR-0029).
- **Propuesta (verificada):** un Service `floci` sin selector + EndpointSlice hacia una IP fija de Floci en la red `aegisvolt-floci` ([ADR-0012](adr/0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md)). La IP fija se configurará en el compose en la fase de K8s.

## L-06 · Exposición de puertos de contenedores hermanos

- El API server de k3s se publica en `0.0.0.0:65xx` del host, no solo en loopback.
- El registry de ECR (`127.0.0.1:5100`) sigue en ejecución después de `stop.sh`.
- **Consola web de Floci** (verificado el 2026-11-14 con Floci 2.4.0):
  - Abrir `http://localhost:4566/_floci/ui` descarga `floci/floci-ui:0.7.0` y arranca el contenedor hermano `floci-aws-ui` en **`0.0.0.0:4500`**, accesible desde la red local, no solo desde el equipo.
  - **No tiene autenticación** y permite crear y borrar recursos del emulador (log groups, alarmas, tablas…).
  - Carga fuentes desde Google Fonts, así que hace peticiones a internet.
  - Sigue en ejecución hasta detenerla (`stop.sh` no la detiene).
- **Mitigación:**
  - uso exclusivamente local;
  - abrir la consola solo cuando se necesite y detenerla al terminar (`docker stop floci-aws-ui`);
  - para consultas, preferir AWS CLI, que solo usa `127.0.0.1:4566` ([runbook](runbooks/observability.md));
  - más adelante se puede revisar `FLOCI_SERVICES_EKS_ENDPOINT_HOST`.

## L-08 · Floci no evalúa IAM: el aislamiento de flags por ambiente no depende de políticas

- **Requisito:** §2.2 y §6.4 — estado de flags independiente por ambiente; un cambio en `dev` no afecta a `prod`.
- **Comportamiento:** Floci acepta cualquier credencial ficticia y no aplica políticas IAM. Un proceso podría leer cualquier tabla si se le indicara.
- **Cómo se cumple de forma verificable ([ADR-0025](adr/0025-feature-flags-por-ambiente-catalogo-escritura-auditada.md)):**
  - una tabla física por ambiente;
  - la tabla de cada proceso se deriva de `APP_ENV`, que fija el despliegue, y en `dev`/`test`/`prod` no se admite otra (el proceso no arranca);
  - ninguna operación acepta un ambiente;
  - el repositorio queda ligado a una sola tabla.

  Lo demuestran la prueba de integración y el [runbook](runbooks/feature-flags-demo.md).
- **En AWS real (fase de IaC):** además, el rol IAM de cada pod solo puede leer `aegisvolt-feature-flags-<su env>`, y solo el graphql-api de ese ambiente puede escribirla. Se verificará con `terraform plan`; Floci no lo puede demostrar.

## L-09 · CloudWatch en Floci: sin Logs Insights `stats` ni EMF; Fluent Bit necesita TLS

- **Requisito:** §2.5 y §5 (punto 4): logs centralizados por ambiente, métricas y trazabilidad por `correlation_id` en CloudWatch.
- **Comportamiento observado** (Floci 2.4.0, `scripts/floci/cloudwatch-probe.sh`, 2026-11-14):
  - Logs Insights solo ejecuta `fields`, `filter` y `sort`. Una consulta con `stats … by` termina `Failed`, sin filas.
  - Un log con formato EMF (`_aws.CloudWatchMetrics`) no genera métricas.
  - *Metric math* no devuelve resultados (L-04).
  - El plugin `cloudwatch_logs` de Fluent Bit 5.1.5 siempre usa TLS (ignora `tls: off`) y no puede hablar con el HTTP de Floci.
- **Cómo se cumple de forma verificable** ([ADR-0029](adr/0029-cloudwatch-fluent-bit-log-groups-metricas.md)):
  - Las métricas salen de **metric filters** (verificados con valor y dimensión desde campos JSON), declarados en Terraform, en lugar de EMF o `stats`.
  - Las agregaciones se consultan con `GetMetricStatistics`; Prefect calcula tasas en el cliente.
  - La traza de una SAGA usa `FilterLogEvents` por grupo o Logs Insights `fields`/`filter`/`sort` sobre los grupos del ambiente (verificado con 5 grupos).
  - Floci corre con `FLOCI_TLS_ENABLED=true`: HTTP y HTTPS en el mismo puerto. Fluent Bit valida el certificado con la CA local de Floci (`tls.verify: on`).
  - La recolección completa (pods → Fluent Bit → log groups → métricas → alarma) se verifica con `scripts/floci/logging-k8s-verify.sh`.
- **En AWS real** funcionan `stats`, EMF y *metric math*; el diseño no depende de ellos.

## L-10 · El clúster k3s de Floci no arranca si su contenedor cambia de IP

- **Requisito:** §2.2 — clúster por ambiente operable de forma repetible.
- **Comportamiento observado** (Floci 2.4.0, k3s v1.36.0+k3s1, 2026-11-15):
  - Floci crea el contenedor `floci-aws-eks-<cluster>` con `node-ip` fijo: la IP que tenía al crearse.
  - Tras reiniciar Docker o el contenedor, la red puede asignarle otra IP.
  - k3s termina con `unable to initialize network policy controller ... failed to find interface with specified node ip` y el API server no vuelve.
- **Recuperación verificada (no destructiva):** reconectar el contenedor a la red de Floci con su IP original y arrancarlo. Conserva el estado del clúster (pods, Rollouts, CRDs).
  ```bash
  docker inspect floci-aws-eks-aegisvolt-dev --format '{{json .Config.Cmd}}'   # o los logs: node-ip original
  docker network disconnect aegisvolt-floci floci-aws-eks-aegisvolt-dev
  docker network connect --ip <ip-original> aegisvolt-floci floci-aws-eks-aegisvolt-dev
  docker start floci-aws-eks-aegisvolt-dev
  ```
- **Alternativa:** borrar y recrear el clúster con `scripts/floci/k8s-deploy.sh <env>`. Es destructiva y requiere autorización.
- **En EKS real** no aplica: el plano de control es administrado y los nodos se reemplazan por el node group.

## L-11 · Memoria local: EKS solo en `dev`

- **Requisito:** §2.2 y §2.4 — un clúster por ambiente.
- **Comportamiento observado** (2026-11-15): Floci levanta un k3s real por clúster, de unos 1,3 GB. La máquina de desarrollo tiene 7,5 GB y unos 2 GB libres con `dev` en marcha, así que no caben `test` y `prod` a la vez.
- **Cómo se cumple de forma verificable:**
  - El módulo `eks` es el mismo en los tres ambientes. `envs/<env>.tfvars` lo enciende con `eks.enabled`: `true` en `dev`; `false` en `test` y `prod`.
  - `test` y `prod` tienen aplicada el resto de su infraestructura (red, tablas, IAM, API Gateway, CloudWatch).
  - Para encender otro clúster (por ejemplo `prod` en la demo), se pone `eks.enabled = true` en su `tfvars` y se ejecuta `scripts/floci/terraform-live.sh prod apply`, con `dev` apagado si hace falta memoria.
- **En AWS real:** `eks.enabled = true` en los tres ambientes.

## L-12 · S3 de Floci guarda la política del bucket de estado, pero no la evalúa

- **Requisito:** bucket de estado con acceso mínimo.
- **Comportamiento:** la documentación de Floci indica que la evaluación de políticas de bucket es nula mientras `FLOCI_SERVICES_S3_ENFORCE_AUTH` está desactivado (por defecto). La política (`DenyInsecureTransport`, `DenyOtherAccounts`, `ProtectBucketAndHistory`) se crea y se lee con `get-bucket-policy`, pero no se aplica. Con ella activa, el acceso de Terraform por `http://localhost:4566` sería denegado por `aws:SecureTransport`.
- **Lo que sí se aplica en Floci:** versionado, SSE, *public access block*, *ownership controls* y *lifecycle* (verificados con `get-bucket-*`).
- **En AWS real:** el backend usa HTTPS y la política se evalúa. El rol `aegisvolt-terraform-admin` es el único que puede cambiar el versionado o el ciclo de vida.

## L-13 · Cognito todavía se crea con AWS CLI

- **Requisito:** §2.4 — "toda la infraestructura... en módulos de Terraform".
- **Estado:** el User Pool, el app client, los grupos y los usuarios de demostración los crea `scripts/floci/bootstrap-env.sh`. Esta fase migró a Terraform lo que pedía el alcance (DynamoDB, red, EKS, API Gateway, IAM, CloudWatch y ECR). Cognito no estaba en esa lista.
- **Propuesta:** un módulo `identity` (`aws_cognito_user_pool`, `aws_cognito_user_pool_client` y `aws_cognito_user_group`) con adopción por import del pool existente. Los usuarios de demostración, con contraseña, seguirían fuera del estado para no guardar secretos en él.

## L-14 · API Gateway, ELB y EC2 de Floci: lo que no se emula o se reporta distinto

- **Requisito:** §2.4 y la fase de red — endpoint HTTPS, logs, SG mínimos y verificación servicio por servicio.
- **Comportamiento observado** (Floci 2.4.0, 2026-11-15, `scripts/floci/network-verify.sh`):
  - **Logs de acceso y métricas de API Gateway:** el stage tiene `access_log_settings` y el log group `/aegisvolt/<env>/api-gateway` existe, pero Floci no escribe eventos (0 streams). Tampoco publica métricas `AWS/ApiGateway`.
  - **HTTP en `execute-api`:** Floci acepta HTTP y HTTPS. En AWS el endpoint de API Gateway solo admite HTTPS. La evidencia usa HTTPS, verificando el certificado con la CA local de Floci.
  - **`enforce_security_group_inbound_rules_on_private_link_traffic`:** Floci no devuelve el atributo del NLB, lo que daría una diferencia permanente en el plan. El módulo lo fija al crear el NLB y lo ignora después (`ignore_changes`, solo ese atributo).
  - **`describe-security-group-rules`** sigue listando la regla de egreso `0.0.0.0/0` por defecto que Terraform revoca al crear el SG, mientras que `describe-security-groups` (y el estado) muestran solo las reglas declaradas. La verificación usa `describe-security-groups`.
  - **Aviso `protocol_version`** del provider en el target group TCP: lo devuelve Floci.
- **Lo que sí funciona:** el camino API Gateway (HTTPS) → VPC Link → listener del NLB → contenedor k3s:NodePort → Traefik → pod, el health check HTTP del target group y los logs del plano de control de EKS.
- **En AWS real:** los logs de acceso de API Gateway requieren el rol de cuenta de `global/` (`aws_api_gateway_account`), ya declarado.

## L-15 · CI/CD: ambientes efímeros en runners hospedados

- **Requisito:** §3 — CI con pruebas y `terraform plan` en cada PR; apply dinámico por rama y canary tras el merge.
- **Restricciones (ADR-0035):**
  - repositorio público con GitHub Free y solo runners hospedados;
  - el Floci persistente del autor no es accesible ni se expone;
  - no hay persistencia entre ejecuciones de GitHub Actions.
- **Consecuencias:**
  - **Plan del PR:** el estado real del ambiente no existe en el runner. Se **reconstruye** aplicando la rama destino en un Floci temporal; si la rama destino no tiene Terraform, el plan se declara "desde cero". No es el estado del Floci persistente del autor.
  - **Despliegue post-merge:** crea, verifica y destruye un ambiente **temporal** (Floci + EKS/k3s + workloads) dentro del runner. **No modifica** el Floci persistente del autor, que se despliega a mano con `scripts/floci/*`.
  - **Canary:** se ejecuta en otro ambiente temporal, con la línea base (la rama antes del merge) como estable. Si la línea base no tiene el canary de Argo (primer despliegue), el job declara "canary no ejecutado".
  - **Recursos del runner:** 4 CPU, 16 GB y 14 GB de disco. El job libera toolchains preinstalados y verifica la capacidad antes de iniciar k3s; si no alcanza, falla con el motivo.
- **Primera ejecución en GitHub** (PR `feature/ci-cd → dev` y su merge, 2026-11-16):
  - **CI, `terraform-plan` y `security`:** pasan todos, incluidos integración y E2E contra el Floci temporal del runner, después de corregir cinco problemas que solo aparecieron en un runner limpio:
    1. `terraform validate` en el workspace `default` de un init limpio: ahora se valida `live` en `dev`, `test` y `prod`;
    2. `pnpm deploy --offline` sin los metadatos que pnpm 12 exige para verificar su política de cadena de suministro: se quitó `--offline` de `deploy`;
    3. el *default setup* de CodeQL activo, que bloquea el *advanced setup*: se desactivó;
    4. cuatro claves de idempotencia UUID marcadas por la regla genérica de Gitleaks: excepción acotada en `.gitleaks.toml`;
    5. CVE-2026-111497 (crítica) en `brotli-libs` de la imagen `web`: actualización a 1.2.1-r0.
  - **`deploy` (post-merge a `dev`):** pasó. Creó, desplegó y verificó el ambiente temporal completo.
  - **`canary-analysis`:** falló al construir la **línea base** (`d2824c9`), que aún tenía el defecto 2 en sus Dockerfiles. Es transitorio: la próxima línea base ya incluye el arreglo. Desde entonces, una línea base que no se puede construir se declara "canary no ejecutado" en vez de fallar, y se construye antes de levantar Floci.
- **Canary verificado en GitHub** (merge de `fix/canary-baseline-build` a `dev`, 2026-11-16):
  - línea base `sha-89fa268b426b` como estable y `sha-136d88df6702` como canary, en el ambiente temporal del runner;
  - **desenlace: Promoted**;
  - tráfico medido en las respuestas (`x-service-version`), sin errores del canary:

    | Pesos TraefikService (estable/canary) | Respuestas | Estable | Canary |
    | --- | --- | --- | --- |
    | antes de publicar | 66 | 100,0 % | 0,0 % |
    | 80/20 | 880 | 79,2 % | 20,8 % |
    | 50/50 | 917 | 47,7 % | 52,3 % |
    | 100/0 (promovido) | 237 | 0,0 % | 100,0 % |

  - La fila de transición 100/0 → 80/20 (9,8 % canary) es el efecto de borde del muestreo cada 5 s, ya documentado en el runbook del canary.
- **Promociones verificadas en GitHub** (2026-11-17): PR #20 `dev → test` y PR #21 `test → prod`, fusionados con *merge commit*. `deploy-floci` terminó en *success* en las tres ramas: `dev` `4e6e269`, `test` `9626f5e` y `prod` `077be0d`.
  - En `test`, la SAGA de verificación terminó `COMPENSATED`, que es lo esperado porque `SIMULATE_CHARGER_HARDWARE_FAULT` está activa en `test`. `k8s-verify.sh` ajusta lo que espera según la flag del ambiente.
  - El canary corrió en `dev` y en `test`. En `prod` se declaró "canary no ejecutado": la línea base (`97c19ce`) no tenía el canary de Argo, porque era el primer despliegue de `prod` con él. No hay evidencia de canary en `prod` hasta el próximo despliegue.
  - El despliegue de `prod` necesitó tres intentos por un arranque fallido de k3s en el runner (L-19).
- **Verificado localmente antes del push:**
  - los scripts (`promotion-guard` con pruebas, `resolve-environment`, `terraform-static-checks`, `terraform-pr-plan` en sus dos modos, `floci-environment` y `canary-release`);
  - el canary del CI contra el `dev` local: línea base `3ba2dc3` estable, el commit como canary, y Argo promovió con 78,7/21,3 y 49,3/50,7.
  - No se pudieron ejecutar `actionlint` ni Gitleaks localmente: se denegó descargar y ejecutar sus binarios en esta sesión. Su lugar lo ocupan `scripts/ci/check-workflows.py`, que ya detectó un error real de YAML, y el informe de hallazgos de Gitleaks en el propio job.

## L-16 · Tres hallazgos de Trivy aceptados como riesgo

- **Requisito:** buenas prácticas de seguridad (CLAUDE.md) y el job `trivy-config` (ADR-0035).
- **Estado:** KSV-0118 (Fluent Bit sin `securityContext` de pod), AWS-0132 (bucket de estado sin CMK propia) y AWS-0039 (Secrets de EKS sin cifrado KMS) están excluidos en `.trivyignore.yaml`. Cada exclusión está acotada a su archivo, justificada y vence el 2027-05-16 ([ADR-0036](adr/0036-riesgos-trivy-aceptados-y-reversion-kms.md)).
- **Por qué no se corrigieron:** el intento se revirtió por L-17. En local, los Secrets solo contienen credenciales ficticias.
- **En AWS real:** CMK propia para el bucket y `encryption_config` al **crear** el clúster, antes de guardar cualquier secreto real.

## L-17 · KMS en Floci: sin `AssociateEncryptionConfig` ni SSE-KMS efectivo en S3

- **Comportamiento observado** (Floci 2.4.0, 2026-11-16, despliegue de `dev` en el runner):
  - **EKS:** agregar `encryption_config` a un clúster existente falla, porque Floci no implementa `AssociateEncryptionConfig`. El k3s de Floci no se integra con KMS.
  - **S3:** la configuración SSE-KMS por defecto del bucket se guarda, pero no se aplica a los objetos nuevos.
- **Consecuencia:** el cifrado con KMS no es verificable en local. Se revirtió y se documentó como riesgo aceptado (L-16).

## L-18 · Prefect no trae configuración para el clúster

- **Requisito:** §2.5, flujos que monitorean los tres ambientes.
- **Estado:** `prefect/config/local.toml` apunta a `pnpm dev` y `config/demo.toml` al stack del E2E. Contra el clúster `dev` de Floci, Prefect se ejecutó con una copia temporal de `local.toml`, con los puertos de `port-forward` a los cinco Services ([observability.md §6.1](runbooks/observability.md#61-contra-el-clúster-dev-de-floci)).
- **Resultado verificado** (2026-11-19): `dev` OPERATIONAL, `test` y `prod` DOWN (sin clúster local, L-11), auditoría de SAGA de `dev` con 0 hallazgos.
- **Pendiente:** un `config/k8s.toml` versionado, o un despliegue de Prefect dentro del clúster que use los Services internos. No hay un Prefect desplegado en Kubernetes.

## L-19 · Arranque intermitente de k3s en los runners de GitHub

- **Comportamiento observado** (despliegue de `prod`, 2026-11-17): en dos intentos el contenedor `floci-aws-eks-aegisvolt-prod` terminó con `Exited (1)` y `kubectl` recibió *connection refused* en `localhost:6500`. El tercer intento pasó sin cambios en el código.
- **Causa:** no determinada. No se reprodujo en local ni en los despliegues de `dev` y `test`.
- **Mitigación actual:** cuando el job falla, `scripts/ci/diagnostics.sh` vuelca el estado de los contenedores (`docker ps -a`) y los logs de Floci y de los pods; después se reintenta el job.
- **Pendiente:**
  - agregar al diagnóstico los logs del propio contenedor k3s (`docker logs floci-aws-eks-aegisvolt-<env>`);
  - un reintento acotado del arranque del clúster.

## L-20 · Los scripts de verificación dejan `port-forward` abiertos

- **Comportamiento observado:** `scripts/floci/k8s-verify.sh` y `scripts/floci/canary-demo.sh` terminan con procesos `kubectl port-forward` todavía vivos.
- **Impacto:** puertos ocupados en una ejecución posterior. No hay impacto en los datos.
- **Mitigación:** cerrarlos al terminar:

  ```bash
  ps -eo pid,args | awk '$2 ~ /kubectl$/ && /port-forward/ {print $1}' | xargs -r kill
  ```

  No uses `pkill -f port-forward`: el patrón puede coincidir con la propia shell que lo ejecuta.
- **Pendiente:** un `trap` que los cierre en los dos scripts.


## L-21 · CVE críticos de nginx en la imagen `web`, aceptados temporalmente

- **Hallazgo** (job `trivy-images`, 2026-11-19, sin cambios en el código: se actualizó la base de datos de Trivy): nginx `1.30.6-r1` de `nginxinc/nginx-unprivileged:1.30-alpine` tiene CVE-2026-113425 (proxy de correo), CVE-2026-121810 (HTTP/3), CVE-2026-123007 y CVE-2026-123633 (HTTP/2). Todos son CRITICAL y están corregidos en `1.30.7-r0`.
- **Por qué no es explotable aquí:** el binario incluye los módulos `mail`, `http_v2` y `http_v3`, pero la configuración efectiva de la imagen solo tiene `listen 8080;`. Es HTTP/1.1 plano, sin `http2`, sin `quic` y sin bloque `mail` (verificado con `grep` sobre `/etc/nginx` dentro de la imagen).
- **Por qué no se actualizó nginx:**
  - `apk add --upgrade nginx` instalaría el nginx de Alpine, que es otro paquete, en lugar del de nginx.org que trae la imagen base.
  - La imagen base corregida es demasiado reciente para la regla de 14 días.
- **Decisión:** los 4 CVE se excluyen de la puerta CRITICAL en `.trivyignore.yaml`, con justificación y vencimiento el **2026-12-19**. `trivy-images` ahora pasa `--ignorefile .trivyignore.yaml` solo a la puerta. El SARIF de Code scanning sigue mostrándolos.
- **Pendiente:** subir el digest de la imagen base en `apps/web/Dockerfile` cuando exista una con nginx ≥ 1.30.7 publicada hace al menos 14 días, y borrar las 4 entradas.
