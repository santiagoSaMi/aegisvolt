# Runbook: desarrollo local

Cómo ejecutar AegisVolt en el equipo de desarrollo. Hay cuatro modos, de más ligero a más completo. Todos usan solo Floci en `localhost` y credenciales ficticias (`test`/`test`). Ninguno toca AWS real.

| Modo | Para qué | Comando principal | Requiere |
| --- | --- | --- | --- |
| A. Procesos Node (`pnpm dev`) | Desarrollar y depurar un servicio | `pnpm dev` | Floci, tablas `*-local`, Cognito local |
| B. Stack de demostración | Ver la consola con datos sin configurar nada | `pnpm --filter @aegisvolt/e2e-tests demo:web` | Floci |
| C. docker compose | Probar las imágenes reales | `scripts/local/compose.sh up` | Floci, Docker |
| D. Kubernetes (EKS/k3s de Floci) | El ambiente `dev` como en la nube: canary, Fluent Bit, NetworkPolicies, API Gateway | `scripts/floci/k8s-deploy.sh dev` | Floci, Terraform aplicado, ~1,3 GB libres |

La instalación de herramientas está en [installation-troubleshooting.md](installation-troubleshooting.md). Floci tiene su propio runbook: [floci.md](floci.md).

## 0. Preparación (una vez)

```bash
nvm install && nvm use          # Node 26 (.nvmrc)
npm install -g pnpm@12.18.0     # versión de packageManager
pnpm install
pnpm check                      # formato, lint, typecheck, unitarias y build
scripts/floci/start.sh          # Floci 2.4.0 en http://localhost:4566
```

## A. Procesos Node con `pnpm dev`

Los cuatro servicios y graphql-api corren como procesos Node, con `--watch`, contra tablas `aegisvolt-*-local` de Floci.

1. **Tablas y flags del ambiente `local`.** El script del ambiente `local` las crea si faltan, junto con el User Pool y los usuarios de demostración:

   ```bash
   scripts/floci/bootstrap-env.sh local
   ```

   Escribe `infra/local/floci/.tmp/identity-local.env` (permisos 0600) con `COGNITO_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_ISSUER`, `COGNITO_JWKS_URL`, los usuarios de demostración (`DEMO_USERS`, flota `DEMO_FLEET`) y su contraseña ficticia (`DEMO_PASSWORD`).

2. **Variables de entorno.** Cada app o servicio tiene un `.env.example`. Cópialo a `.env` (ignorado por Git). En `apps/graphql-api/.env`, usa los valores de `identity-local.env`:
   - `COGNITO_ISSUER` (`https://floci:4566/<pool>`);
   - `COGNITO_JWKS_URL`;
   - `COGNITO_CLIENT_ID`.

   Detalle en la [guía GraphQL §1](../graphql/README.md#1-ejecutar-en-local-contra-floci).

3. **Arrancar:**

   ```bash
   pnpm dev                                    # orquestador 4100, station 4101, billing 4102, energy 4103, graphql 4000, web 5173
   pnpm --filter @aegisvolt/web dev            # solo la consola (proxy /graphql → :4000, /auth/cognito → Floci)
   pnpm --filter @aegisvolt/billing-wallet-service dev   # solo un servicio
   ```

4. **Datos de ejemplo:** para registrar estaciones y recargar la billetera, ver [saga-demo.md §3](saga-demo.md#3-demostración-manual-en-vivo-servicios-en-dev-local).

Si modificas `packages/*`, recompila con `pnpm build:packages`. No ejecutes `pnpm dev` a la vez que el modo C: usan los mismos puertos.

## B. Stack de demostración (consola con datos)

```bash
pnpm --filter @aegisvolt/e2e-tests demo:web
```

Levanta los cinco procesos con tablas temporales, un User Pool de prueba y datos sembrados, en los puertos 24100–24105. La salida indica la URL y los usuarios. Lo usa `prefect/config/demo.toml`. Detalle en [web-console-demo.md](web-console-demo.md).

## C. docker compose (imágenes reales)

```bash
scripts/local/compose.sh up      # bootstrap del ambiente local, build con etiqueta inmutable y arranque con --wait
scripts/local/compose.sh seed    # 2 estaciones y la billetera de fleet_demo con saldo
scripts/local/compose.sh logs -f graphql-api
scripts/local/compose.sh down
```

La consola queda en http://127.0.0.1:8080 y graphql-api en http://127.0.0.1:4000/graphql. Detalle y troubleshooting: [kubernetes.md §2](kubernetes.md#2-ejecución-local-con-docker-compose).

## D. Ambiente `dev` en Kubernetes (EKS/k3s de Floci)

```bash
scripts/floci/terraform-bootstrap.sh apply
scripts/floci/terraform-global.sh apply
scripts/floci/terraform-live.sh dev && scripts/floci/terraform-live.sh dev apply   # red, tablas, IAM, EKS, API Gateway, CloudWatch
scripts/floci/k8s-deploy.sh dev                  # imágenes → ECR → clúster → rollout → humo
scripts/floci/k8s-verify.sh dev                  # NetworkPolicies, seguridad, SAGA, CloudWatch
```

Abrir la consola **a través de Traefik**, para que el navegador también participe del canary:

```bash
S=infra/local/floci/.tmp/k8s-dev
(set -a; source $S/kube-credentials.env; set +a; KUBECONFIG=$S/kubeconfig kubectl -n traefik port-forward svc/traefik 8080:80)
# http://127.0.0.1:8080 · usuarios operador y admin · contraseña en infra/local/floci/.tmp/identity-dev.env (DEMO_PASSWORD)
```

Operación del clúster: [kubernetes.md](kubernetes.md). Terraform: [terraform.md](terraform.md).

## Pruebas

| Comando | Qué cubre | Requiere Floci |
| --- | --- | --- |
| `pnpm test` | Unitarias de todo el monorepo (dominio, casos de uso, compensaciones, resolvers) | No |
| `REQUIRE_INTEGRATION=true pnpm test:integration` | DynamoDB real y GraphQL; aislamiento de flags por ambiente | Sí |
| `REQUIRE_INTEGRATION=true pnpm test:e2e` | SAGA con los cinco procesos reales, GraphQL con Cognito y consola en Chromium | Sí |
| `cd prefect && .venv/bin/pytest` | Reglas y flows de Prefect con fixtures | No |
| `pnpm check` | Formato, lint (incluido dependency-cruiser), typecheck, unitarias y build | No |

Sin `REQUIRE_INTEGRATION=true`, las pruebas de integración y E2E se **omiten** si Floci no responde. Con la variable, fallan. Úsala siempre que quieras una evidencia.

Resultados de la auditoría del 2026-11-19 (`infra/local/floci/.tmp/audit-20261119/`):

- 554 pruebas unitarias;
- 46 de integración;
- 19/19 E2E;
- 25 de Prefect;
- todas correctas.

No hay métricas de cobertura publicadas.

## Apagar

```bash
scripts/local/compose.sh down     # si usaste el modo C
scripts/floci/stop.sh             # detiene Floci y conserva los datos
docker stop floci-aws-eks-aegisvolt-dev floci-aws-ecr-registry   # el clúster y el registry siguen vivos tras stop.sh
```

Al volver a arrancar el clúster, si k3s no levanta, ver [L-10](../limitations.md#l-10--el-clúster-k3s-de-floci-no-arranca-si-su-contenedor-cambia-de-ip).
