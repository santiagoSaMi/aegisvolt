# ADR-0031: Imágenes de contenedor, manifiestos de Kubernetes y desarrollo local con Floci

- **Estado:** Aceptado
- **Fecha:** 2026-11-15
- **Concreta:** [ADR-0012](0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md) (clúster por ambiente, Kustomize, acceso a Floci) y [ADR-0017](0017-frontend-spa-mismo-origen-polling.md) (SPA en nginx con `config.json` de ejecución)

## Contexto

CLAUDE.md exige una imagen por unidad con build multi-stage y usuario no root. La especificación (§2.2) pide desplegar en Kubernetes con ambientes aislados. Esta fase pide además:

- imágenes mínimas y reproducibles, con etiquetas inmutables por commit;
- configuración por entorno, apagado ordenado y healthcheck;
- en Kubernetes: Deployments, namespaces, ConfigMaps y Secrets sin valores sensibles, recursos, probes, *security contexts*, ServiceAccounts, NetworkPolicies, y Kustomize con overlays `dev`, `test` y `prod`;
- un entorno local integrado con Floci;
- verificar que el EKS de Floci permite desplegar y operar workloads, sin afirmar equivalencia con EKS administrado.

El pedido habla de "tres microservicios", pero el sistema tiene **cuatro** servicios backend. `saga-orchestrator` es imprescindible para la SAGA y también se contenedoriza. En total son seis imágenes: `web`, `graphql-api`, `station-reservation`, `billing-wallet`, `energy-dispatch` y `saga-orchestrator`.

## Decisión

### Imágenes

| | Unidades Node (5) | web |
| --- | --- | --- |
| Base | `node:26.12.1-alpine` fijada por digest (imagen del 2026-10-21) | build con la misma base; runtime `nginxinc/nginx-unprivileged:1.30-alpine` por digest (2026-10-19) |
| Etapas | `deps` (`pnpm fetch` del lockfile, capa cacheable) → `build` (paquetes del workspace + app, `pnpm deploy --prod`) → `runtime` | `deps` → `build` (`vite build`) → nginx |
| Contenido final | `/app` = `dist` + `node_modules` de producción (~38 MB), de root y de solo lectura | `dist` estático, sin `config.json` |
| Usuario | `node` (uid 1000) | uid 101 |
| Superficie | Sin npm, npx, corepack ni yarn (se borran en la etapa final) | nginx sin módulos extra |
| Tamaño | 294 MB (320 MB graphql-api). Casi todo es el binario de Node 26 | 91 MB |
| Healthcheck | `node -e fetch(/health/live)` | `wget /healthz` |
| Apagado | `node` como PID 1 recibe SIGTERM; cada servicio cierra su servidor HTTP | `STOPSIGNAL SIGQUIT` (cierre ordenado de nginx) |

- **Configuración: solo por variables de entorno.**
  - Los servicios la validan al arrancar y no arrancan con valores inválidos. Por ejemplo, el orquestador rechazó un `SHUTDOWN_GRACE_MS` que no superaba `HTTP_REQUEST_TIMEOUT_MS`.
  - En la web, un script de `/docker-entrypoint.d` valida las variables y la plantilla de nginx genera con ellas `config.json` y los proxies `/graphql` y `/auth/cognito`. La misma imagen sirve para `dev`, `test` y `prod`.
- **Reproducibilidad:**
  - imágenes base fijadas por digest;
  - `pnpm` 12.18.0 fijo;
  - `--frozen-lockfile`;
  - un `Dockerfile.dockerignore` por imagen, con lista blanca (el contexto solo incluye la app y los paquetes que usa).
  - No es reproducible bit a bit: las marcas de tiempo de las capas varían.
- **Etiquetas inmutables** (`scripts/docker/build-images.sh`):
  - `sha-<commit 12>` con el árbol limpio;
  - `sha-<commit>-dirty-<marca de tiempo>` si hay cambios sin commit, para que nunca se reutilice una etiqueta con otro contenido;
  - nunca `latest`;
  - los repositorios de ECR se crean con `IMMUTABLE`;
  - la imagen lleva `org.opencontainers.image.revision` y `SERVICE_VERSION=<commit>`.
- **Web con nginx:**
  - CSP estricta (`default-src 'self'`, sin `unsafe-inline`), verificada sin violaciones en Chromium;
  - `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy`;
  - caché inmutable para `/assets`;
  - logs de acceso en JSON con el esquema de ADR-0028 (`service_name: web`), que van al log group `/aegisvolt/<env>/web`.

### Kubernetes (`infra/k8s`)

- **Base:**
  - namespace `aegisvolt` con Pod Security Admission `restricted`, más el namespace `logging` existente;
  - por app: Deployment, Service `ClusterIP` (80 → 8080), ServiceAccount sin token (`automountServiceAccountToken: false`), ConfigMap generado desde `config.env` y NetworkPolicy.
- **Deployments:**
  - `RollingUpdate` con `maxUnavailable: 0`;
  - pod `runAsNonRoot` con seccomp `RuntimeDefault`; contenedor sin capacidades, sin escalada y con `readOnlyRootFilesystem` (`emptyDir` en `/tmp` y, en la web, en `conf.d`);
  - requests y limits; `NODE_OPTIONS=--max-old-space-size=192` con un límite de 256 Mi;
  - probes: *startup* y *liveness* en `/health/live`, *readiness* en `/health/ready` (comprueba DynamoDB); en la web, `/healthz`;
  - `preStop: sleep 5 s` para que el pod salga de los endpoints antes de SIGTERM, y `terminationGracePeriodSeconds` mayor que la ventana de apagado de cada app.
  - **Deployments, no Rollouts:** el canary con Argo Rollouts (ADR-0013) llega con CI/CD. El cambio de `kind` está acotado a los overlays.
- **NetworkPolicies** (se suman):
  - `default-deny-all` (entrada y salida) y `allow-dns-egress`;
  - `allow-aws-egress` (443; VPCE en AWS real);
  - una por app con quién puede llamarla y a quién llama:
    - web → graphql-api;
    - graphql-api → los 4 servicios;
    - orquestador → station, billing y energy;
    - los 3 servicios solo reciben de graphql-api y del orquestador.
- **Config y Secrets:**
  - en Git solo configuración no sensible;
  - el ConfigMap `aegisvolt-identity` (emisor, JWKS y app client de Cognito, que no son secretos) lo publica el despliegue: en AWS real, Terraform;
  - las credenciales AWS: IRSA o Pod Identity en AWS real (pendiente, fase de IaC); en local, el Secret de credenciales **ficticias** del componente `floci`.
- **Overlays `dev`, `test`, `prod`:**
  - `APP_ENV`, tablas `aegisvolt-<dominio>-<env>`, nivel de log y el ambiente del colector;
  - `prod`: 2 réplicas, más CPU solicitada y PodDisruptionBudgets.
  - Las imágenes no se fijan en Git: el despliegue genera una kustomization con `images` (ECR y `sha-…`) sobre el overlay.
- **Componente `floci` (solo local):**
  - Service `floci` sin selector + EndpointSlice a la IP de Floci (L-07);
  - `AWS_ENDPOINT_URL=http://floci:4566` y Secret ficticio para las apps Node;
  - en la web, `COGNITO_UPSTREAM=http://floci:4566`;
  - `allow-floci-egress`: TCP 4566 a la IP de Floci; la política evalúa la IP tras el DNAT del Service.

### Desarrollo local integrado (`infra/local/compose`)

- `docker-compose.yml` con las seis imágenes en la red Docker de Floci (`aegisvolt-floci`, externa).
- Dentro de la red, los contenedores usan `http://floci:4566` y los nombres de servicio (`http://graphql-api:4000`), nunca `localhost`.
- Puertos publicados solo en `127.0.0.1`.
- `read_only`, `cap_drop: ALL`, `no-new-privileges` y `tmpfs` en `/tmp`.
- Arranque ordenado por `healthcheck` (`depends_on: service_healthy`).
- El emisor de Cognito es `https://floci:4566/<pool>` (TLS de Floci, ADR-0029) y el JWKS se lee por HTTP dentro de la red.
- `scripts/local/compose.sh up` ejecuta el bootstrap del ambiente `local` (tablas, flags, Cognito y usuarios de demostración, con `scripts/floci/bootstrap-env.sh`), construye y arranca.

### Despliegue en el EKS (k3s) de Floci

`scripts/floci/k8s-deploy.sh <env>`, idempotente:

1. imágenes;
2. ECR de Floci;
3. clúster `aegisvolt-<env>` (k3s 1.36);
4. bootstrap del ambiente;
5. manifiestos (overlay + imágenes + IP de Floci) y rollouts;
6. prueba de humo: salud, `config.json`, login real con Cognito por la web y GraphQL.

`scripts/floci/k8s-verify.sh <env>` comprueba la operación (ver resultados).

## Verificación (Floci 2.4.0, k3s v1.36.0+k3s1, 2026-11-15)

- **Imágenes y compose:**
  - las seis imágenes se construyen;
  - en compose quedan `healthy`, con salud 200 y cabeceras de seguridad;
  - una SAGA real termina COMPLETED a través de nginx;
  - la consola carga sin violaciones de CSP;
  - apagado ordenado: `docker stop` en 0,24 s, exit 0, con logs `Apagado solicitado` y `Servicio detenido`;
  - no root, sistema de archivos de solo lectura y `/tmp` escribible.
- **EKS de Floci (`dev`):**
  - pull desde el ECR de Floci y rollouts 6/6;
  - probes y DNS de Services;
  - **las NetworkPolicies se aplican**: 3 conexiones permitidas y 3 bloqueadas, y un error de configuración (políticas en otro namespace) se manifestó como DNS bloqueado;
  - Pod Security Admission `restricted`;
  - `exec` y `port-forward`;
  - una SAGA real COMPLETED;
  - logs reales de las 6 unidades en `/aegisvolt/dev/<servicio>` vía Fluent Bit con el mismo `correlation_id`;
  - la métrica `SagaCompleted` se genera.
- **`test` y `prod`:** se validaron con `kubectl apply --dry-run=server` contra el API server real (48 y 54 objetos aceptados).

## Alternativas

1. **Distroless (`nodejs26-debian13`).**
   - Sin shell y con menos paquetes, pero solo existe con etiquetas móviles (traía Node 26.13.1, de noviembre): no se puede fijar a una versión con la antigüedad mínima.
   - Pesa casi lo mismo (243 MB).
   - Sin shell, `kubectl exec` no sirve para diagnosticar.
2. **Copiar solo el binario de Node sobre `alpine`.** Ahorraría ~100 MB, pero deja de ser la imagen oficial mantenida (certificados, parches) y suma otra base que fijar.
3. **Argo Rollouts ya.** Exige instalar el controlador y su análisis (ADR-0013). Corresponde a la fase de CI/CD y canary.
4. **Helm.** Innecesario para manifiestos propios (ADR-0012).
5. **`NodePort` o `LoadBalancer` para exponer.** En Floci no hay balanceador de clúster integrado. Con `port-forward` basta para verificar; en AWS la entrada es NLB, VPC Link y API Gateway (ADR-0010, fase de IaC).

## Consecuencias

- **Positivas:**
  - Una sola imagen por app se promueve entre ambientes cambiando solo la configuración.
  - Mínimo privilegio en contenedor, pod y red.
  - El despliegue local reproduce el de AWS salvo el componente `floci`.
  - La operación en el EKS de Floci quedó verificada con datos reales.
- **Negativas:**
  - Las imágenes Node pesan ~300 MB por el binario de Node 26.
  - El EKS de Floci es k3s:
    - un nodo, sin balanceador;
    - sin IRSA verificado;
    - API server publicado en `0.0.0.0` (L-03 y L-06).
  - La IP de Floci se inyecta al desplegar, hasta fijarla en el compose.
  - Las NetworkPolicies dependen de kube-router (k3s); en EKS hace falta el *network policy agent* de VPC CNI o Calico.
