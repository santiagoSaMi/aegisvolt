# Guía de demostración

Guion de una demostración completa de AegisVolt en unos 20 minutos, sobre el ambiente `dev` local (Floci y EKS/k3s). Recorre las cinco capas de la rúbrica (§5.2) en el orden en que se explican mejor. Los comandos exactos están en la [guía de sustentación](../guia-sustentacion.md); aquí se indica qué mostrar y en qué orden.

Antes de empezar, completa la [preparación](../guia-sustentacion.md#0-preparación): `k8s-verify.sh dev` en verde, variables de la terminal y helpers cargados, y pestañas de GitHub abiertas.

## Guion

| Min. | Capa | Qué mostrar | Cómo |
| --- | --- | --- | --- |
| 0–2 | Contexto | Problema y arquitectura | [overview.md](../architecture/overview.md): diagramas lógico y de secuencia |
| 2–4 | Frontend | Consola de `dev`: badge **DEV**, estaciones y conectores disponibles | Navegador en `http://127.0.0.1:18090` (Traefik), usuario `operador` |
| 4–7 | SAGA (éxito) | Iniciar una carga → **Completada**, con pasos y `correlation_id` | Consola → **Carga** |
| 7–11 | Flags + SAGA (fallo) | `admin` activa `SIMULATE_CHARGER_HARDWARE_FAULT` → `operador` inicia otra carga → **Compensada** | Consola. Luego, en la terminal, `flag dev` y `flag prod` (prod intacto) y los ítems de DynamoDB ([6.3.1](../guia-sustentacion.md#631-active-la-feature-flag-de-fallo-en-el-ambiente-test-dispare-una-mutación-graphql-de-reserva-de-carga-y-demuestre-en-las-tablas-de-dynamodb-cómo-se-ejecutó-la-transacción-compensatoria-en-el-servicio-de-facturación-y-reservas), pasos 4–7) |
| 11–12 | Idempotencia | Repetir el reembolso → `ALREADY_REFUNDED` | [6.3.2](../guia-sustentacion.md#632-cómo-evita-su-implementación-de-saga-problemas-de-falta-de-idempotencia-si-un-mensaje-o-petición-de-compensación-se-procesa-dos-veces), demostración manual |
| 12–14 | Observabilidad | `correlation_id` de la carga compensada en los 5 log groups; métrica `SagaCompensated`; flows de Prefect | [6.4.1](../guia-sustentacion.md#641-muestre-en-prefect-la-ejecución-del-flujo-de-observabilidad-y-rastree-en-cloudwatch-el-correlation_id-de-una-transacción-saga-fallida) |
| 14–17 | IaC | Workspaces, claves `env:/…` en S3, versiones del estado de `dev`, guarda de `tfvars` | [6.1.1](../guia-sustentacion.md#611-cómo-garantiza-su-código-de-terraform-que-al-ejecutar-terraform-apply-en-la-rama-test-no-se-sobrescriban-las-tablas-de-dynamodb-ni-el-estado-del-ambiente-prod-en-s3) y [6.1.2](../guia-sustentacion.md#612-muestre-en-su-bucket-s3-las-versiones-anteriores-del-archivo-terraformtfstate-del-workspace-dev-y-explique-cómo-restauraría-la-versión-previa-ante-un-cambio-corrupto) |
| 17–18 | Red | `network-verify-dev.md`: qué es funcional y qué es metadato | [6.1.3](../guia-sustentacion.md#613-explique-el-recorrido-de-un-paquete-de-red-desde-el-api-gateway-hasta-el-pod-en-kubernetes-a-través-del-vpc-endpoint-vpce-y-qué-tabla-de-enrutamiento-o-política-de-seguridad-interviene) |
| 18–20 | CI/CD y canary | Rulesets, PR #20 y #21, ejecución `deploy-floci` de `test`, `AnalysisTemplate` y el informe de un canary | [6.2](../guia-sustentacion.md#62-cicd-promoción-de-ambientes-y-canary-25-) |

**Al terminar:**

1. Apaga la flag de falla (consola o `set_flag false`). La siguiente carga vuelve a **Completada**.
2. Cierra los `port-forward`:

   ```bash
   ps -eo pid,args | awk '$2 ~ /kubectl$/ && /port-forward/ {print $1}' | xargs -r kill
   ```

## Demostraciones largas (solo si las piden)

| Demostración | Duración | Comando |
| --- | --- | --- |
| Canary con promoción | ~6 min | `scripts/floci/canary-demo.sh dev success` |
| Canary con rollback | ~4 min | `scripts/floci/canary-demo.sh dev failure` |
| Apply en `test` sin tocar `dev` ni `prod` | ~4,5 min | `scripts/floci/terraform-evidence.sh` |
| Suite E2E completa (SAGA, GraphQL, consola en Chromium) | ~30 s | `REQUIRE_INTEGRATION=true pnpm test:e2e` |
| Verificación del clúster (NetworkPolicies, SAGA, CloudWatch) | ~2 min | `scripts/floci/k8s-verify.sh dev` |

## Plan B (si el clúster no responde)

1. Intenta recuperar k3s con [L-10](../limitations.md#l-10--el-clúster-k3s-de-floci-no-arranca-si-su-contenedor-cambia-de-ip). Toma 1–2 minutos.
2. Si no basta, usa el stack sin Kubernetes: `pnpm --filter @aegisvolt/e2e-tests demo:web` (consola con datos en el puerto 24105) y `REQUIRE_INTEGRATION=true pnpm test:e2e`. Muestra las capturas de `tests/e2e/.evidence/web/` y los JSON de DynamoDB de `tests/e2e/.evidence/`.
3. Di con claridad que es el plan B. Los mismos servicios y tablas de DynamoDB corren en Floci, pero sin el clúster.
