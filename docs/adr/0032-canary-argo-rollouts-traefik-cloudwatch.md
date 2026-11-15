# ADR-0032: Canary de graphql-api con Argo Rollouts, reparto por peso en Traefik y análisis en CloudWatch

- **Estado:** Aceptado
- **Fecha:** 2026-11-15
- **Reemplaza:** [ADR-0013](0013-canary-argo-rollouts-analisis-cloudwatch.md) (canary por réplicas y análisis con un Job)

## Contexto

§3.3 de la especificación exige:

- un canary con el 10–20 % del tráfico;
- verificar salud y métricas de error en CloudWatch;
- promover al 100 % o hacer rollback automático.

La fase pide un canary **real**:

- dos versiones identificables;
- un mecanismo de reparto de tráfico (no RollingUpdate y no porcentajes inferidos del número de pods);
- 80/20 inicial, evaluación, promoción gradual o abort;
- umbrales explícitos de error y disponibilidad, sin promover con muestras insuficientes.

ADR-0013 se escribió antes de poder verificar contra el clúster. Partía de tres supuestos:

- reparto por réplicas;
- análisis con un Job;
- "el proveedor CloudWatch no está en el núcleo".

Esta fase los comprobó y dos resultaron falsos. Por eso ADR-0013 se reemplaza.

## Verificación previa (Floci 2.4.0, k3s v1.36.0+k3s1, 2026-11-15)

| Pregunta | Resultado | Cómo se comprobó |
| --- | --- | --- |
| ¿Versión de Argo Rollouts? | **v1.10.1** (2026-10-12). La 1.10.2 no cumple la antigüedad mínima de 14 días | release de GitHub; `install.yaml` fijado por sha256 y la imagen por digest |
| ¿ingress-nginx? | **Descartado:** el proyecto fue archivado el 2026-03-24 (sin parches de seguridad) | repositorio `kubernetes/ingress-nginx` |
| ¿ALB? | **No viable:** Floci no implementa el AWS Load Balancer Controller ni ALB funcionales sobre k3s | L-01, L-03 |
| ¿Traefik? | **Sí.** v3.7.16 (2026-10-20). Argo lo soporta de forma nativa (`trafficRouting.traefik`) mediante un `TraefikService` con pesos (*weighted round robin*) | instalado en `aegisvolt-dev`; Argo reescribe los pesos (100/0 → 80/20 → 50/50 → 0/100) |
| ¿El k3s de Floci trae Traefik? | No: Floci lo crea sin Traefik. Se instala uno propio, fijado y sin privilegios | `kubectl get pods -A` |
| ¿Proveedor CloudWatch de Argo contra Floci? | **Sí.** Está en el núcleo del controlador (AWS SDK v2) y respeta `AWS_ENDPOINT_URL`. Un AnalysisRun independiente leyó `GetMetricData` de Floci | `AWS_ENDPOINT_URL=http://floci:4566`, credenciales ficticias y `AWS_REGION` en el controlador |
| ¿Metric math en Floci? | No (L-04). La tasa se calcula en la condición del análisis con dos series | ver plantilla |

Sintaxis del resultado del proveedor CloudWatch (comprobada):

- el resultado es la lista de `MetricDataResult`, así que se usa `result[0].Values`, `sum(result[0].Values)` y `result[0].Id`;
- una *closure* (`filter(result, {.Id == "x"})`) no se evalúa, así que se indexa y se comprueba el `Id`;
- sin datos, Floci devuelve la serie con `Values` vacío.

## Decisión

### Qué se despliega con canary

- **Solo `graphql-api`.** Es el único que recibe tráfico externo (norte-sur), que es lo que un *ingress* puede repartir por peso.
- Los servicios de dominio se llaman este-oeste por `ClusterIP`. Repartir ese tráfico por peso exige una malla de servicios (Istio, Linkerd) o el SMI. Eso añade un plano de datos completo que no se justifica en un clúster de un solo nodo.
- El canary del BFF ejercita las rutas a los cuatro servicios: un fallo de integración del BFF con cualquiera de ellos aparece en su tasa de error.
- El resto de las apps sigue con `RollingUpdate` (ADR-0031), que se presenta como lo que es, no como canary.

### Plataforma (`infra/k8s/platform`)

- **`argo-rollouts`:**
  - `install.yaml` oficial v1.10.1 descargado y verificado por sha256 (`scripts/k8s/vendor-platform.sh`; el archivo no se versiona);
  - imagen fijada por digest;
  - namespace propio.
- **`traefik`:**
  - CRDs y RBAC oficiales v3.7.16 (sha256), imagen por digest;
  - solo el proveedor `kubernetescrd`;
  - entrypoint `:8000`, `ping` y *access log* JSON;
  - `runAsNonRoot` (65532), raíz de solo lectura, sin capacidades;
  - Service `ClusterIP`: en local se entra por `port-forward`; en AWS, por NLB (ADR-0010).
- **`local`:**
  - Service `floci` + EndpointSlice en `argo-rollouts`;
  - `AWS_ENDPOINT_URL` y un Secret con credenciales **ficticias** para el controlador.
  - En AWS real esto se sustituye por IRSA/Pod Identity con `cloudwatch:GetMetricData`.

### Componente `components/canary`

- **`Rollout graphql-api`** con `workloadRef` al Deployment existente:
  - el Deployment queda en `replicas: 0` y sigue siendo la plantilla;
  - en `prod`, el Rollout tiene 2 réplicas.
- **Dos versiones identificables:**
  - el despliegue etiqueta la plantilla con `version=<etiqueta inmutable>`;
  - el pod la recibe en `SERVICE_VERSION` (`fieldRef`);
  - graphql-api la devuelve en la cabecera **`x-service-version`** de cada respuesta y la escribe en el campo `version` de cada log.
- **Reparto:**
  - `stableService: graphql-api` y `canaryService: graphql-api-canary`; Argo fija el `rollouts-pod-template-hash` en sus selectores;
  - `TraefikService graphql-api-split` (WRR);
  - `IngressRoute aegisvolt`: `/graphql` va al split y `/` a la web.
- **Pasos:**
  1. `setWeight: 20`, es decir 80 % estable y 20 % canary;
  2. `analysis`;
  3. `setWeight: 50`;
  4. `analysis`;
  5. 100 %.
  - `abortScaleDownDelaySeconds` y `scaleDownDelaySeconds` en 30 s.
  - **Abort:** Argo devuelve el peso 100/0 al estable y escala a cero el canary.

### SLI y umbrales (`AnalysisTemplate graphql-api-canary-health`)

| Métrica | Fuente | Ventana y mediciones | Éxito | Fallo |
| --- | --- | --- | --- | --- |
| `availability` | proveedor `web`: `GET /health/ready` del Service canary (proceso vivo y su dependencia propia, la tabla de flags; no los servicios internos) | cada 10 s, **12 mediciones** (2 min) | `status == "ready"` | más de 1 fallo (disponibilidad < 11/12 ≈ 91,7 %) |
| `error-rate` | proveedor `cloudWatch` (CloudWatch de Floci): `GraphqlOperations` y `GraphqlServerErrors` con `Version=<canary>` | espera inicial 60 s; cada 30 s, **4 mediciones**, ventana de **3 min** (períodos de 60 s, `Sum`) | ≥ **30** operaciones y errores/operaciones ≤ **2 %** | ≥ 30 operaciones y tasa > 2 %; se tolera 1 medición fallida (`failureLimit: 1`) |

- **Las dos métricas son necesarias.** Un BFF mal configurado hacia un servicio interno sigue `ready` (la readiness no incluye los servicios internos, para que una caída aguas abajo no saque al BFF de rotación). Solo lo detecta `error-rate`. A la inversa, un canary que no arranca o pierde DynamoDB lo detecta `availability` antes de tener tráfico.
- **Muestra mínima:** con menos de 30 operaciones no se cumple ninguna condición. La medición queda **Inconclusive** y Argo **pausa** el Rollout: no promueve ni aborta y espera a un operador. Nunca se promueve con una muestra insuficiente.
- **SLI de error.** GraphQL responde HTTP 200 aunque falle un servicio aguas abajo, así que el código HTTP no sirve como SLI. Se usa el resultado de cada operación:
  - el plugin `logOperationPlugin` emite un log `graphql_operation` con `outcome` (`ok`, `client_error` o `server_error`);
  - `server_error` corresponde a los códigos `SERVICE_UNAVAILABLE` e `INTERNAL_SERVER_ERROR`;
  - los errores de cliente (validación, autenticación, reglas de negocio) no cuentan;
  - las SAGAs `COMPENSATED` son resultados de negocio válidos y tampoco cuentan.
- **Métricas:** dos metric filters de Terraform (`modules/cloudwatch`) sobre `/aegisvolt/<env>/graphql-api`, con dimensiones `ServiceName` y `Version`.
- **Ambiente:** el argumento `environment` lo fija cada overlay (`AegisVolt/dev|test|prod`).

## Alternativas

1. **Canary por réplicas (ADR-0013).** El porcentaje depende del número de pods: con 1 réplica no hay 20 %. La fase lo excluye explícitamente.
2. **ingress-nginx con anotaciones canary.** Archivado, sin parches de seguridad.
3. **Gateway API (plugin de Argo).** Es un plugin aparte y añade otra pieza que fijar. Traefik está soportado en el núcleo.
4. **Malla de servicios para el tráfico este-oeste.** Daría canary a los servicios de dominio, pero añade *sidecars* o un plano de datos completo. Queda como evolución.
5. **Análisis con un Job (ADR-0013).** Era necesario solo si el proveedor CloudWatch no funcionaba. Funciona, así que no se añade código propio.
6. **Prometheus.** Exigiría otro sistema de métricas cuando la especificación pide CloudWatch.

## Consecuencias

- **Positivas:**
  - Reparto real por peso, medido en las respuestas.
  - Análisis declarativo con umbrales explícitos contra la misma fuente de métricas que en AWS.
  - Rollback automático sin depender de un *runner*.
- **Negativas:**
  - Se suman dos controladores (Argo Rollouts y Traefik) y sus CRDs.
  - Solo graphql-api tiene canary.
  - La métrica de error llega con la latencia de Fluent Bit y de los metric filters (~10–30 s): el análisis espera 60 s antes de medir.
- **Pendiente de validar en AWS real:** ver [`docs/limitations.md` L-04](../limitations.md#l-04--canary-con-métricas-de-cloudwatch).

## Evidencia

Ver [docs/runbooks/canary-demo.md](../runbooks/canary-demo.md).
