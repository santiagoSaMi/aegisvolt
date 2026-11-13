# ADR-0013: Canary con Argo Rollouts (por réplicas) y análisis mediante Job contra CloudWatch

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§3.3 exige:
- desplegar un canary con el 10–20 % del tráfico;
- verificar la salud o las métricas de error en CloudWatch;
- promover al 100 % o hacer rollback automático.

§6.2 pregunta qué métrica se evalúa. Datos de partida:
- Argo Rollouts v1.10.2 es la última versión estable;
- sin *traffic router*, reparte el tráfico por número de réplicas;
- su núcleo incluye los proveedores Job y Web, pero no CloudWatch;
- Floci no soporta *metric math* ni `stats` en Logs Insights; `get-metric-statistics` y los metric filters sí funcionan (verificado).

## Decisión

- **Argo Rollouts v1.10.2** con estrategia canary por réplicas:
  - pasos `setWeight: 20` → `pause 60s` → `analysis` → `setWeight: 100`;
  - etiquetas `track: canary|stable`.
- **Réplicas:** 5 en `prod` (20 % exacto) y 2 en `dev` (50 % efectivo, documentado).
- **`AnalysisTemplate canary-health` con proveedor Job.** El Job ejecuta un *checker* con AWS CLI contra CloudWatch (Floci en local) y comprueba:
  - tasa de error de la versión canary ≤ 1 % con al menos 30 requests en la ventana, contada a partir de los logs (`version`, `http_status`, `level`);
  - réplicas canary `Ready`.
- Las SAGAs `COMPENSATED` son resultados válidos de negocio (HTTP 200) y no cuentan como error.
- **Si el análisis falla:** abort con rollback automático, y el job de CD falla.

## Alternativas

1. **Canary manual en el pipeline** (dos Deployments y scripts). No añade CRDs, pero el rollback depende de que el runner siga vivo; no es declarativo.
2. **Flagger.** Requiere un *mesh* o un ingress compatible para el reparto de tráfico.
3. **Argo Rollouts con *traffic routing* (Traefik u otro).** Da porcentajes exactos sin depender de las réplicas, pero en EKS exige instalar y operar un ingress adicional. Es una evolución posible.
4. **Proveedor CloudWatch** (plugin). No está en el núcleo y no se verificó que admita un endpoint configurable.

## Consecuencias

- **Positivas:** rollback automático y declarativo, con una métrica explícita y defendible.
- **Negativas:**
  - El porcentaje es aproximado y depende de las réplicas.
  - El controlador añade un CRD.
  - El *checker* es código adicional que hay que probar.
- **Pendiente de verificar:** `canaryMetadata`/`stableMetadata` y los filtros JSON en Floci.
