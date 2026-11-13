# 03 · Feature flags, aislamiento por ambiente y seguridad

Cubre los puntos 10 y 11. Decisiones: [ADR-0007](../adr/0007-feature-flags-dynamodb-por-ambiente.md) y [ADR-0008](../adr/0008-autenticacion-cognito-autorizacion-por-grupos.md).

## 10. Feature flags por ambiente

### Mecanismo

- **Almacén:** una tabla DynamoDB **por ambiente**, `aegisvolt-feature-flags-<env>`, creada por Terraform en el workspace correspondiente. El aislamiento es físico: `dev` y `prod` no comparten tabla, así que un cambio en `dev` no puede afectar a `prod`.
- **Valores iniciales:** Terraform siembra cada flag con `aws_dynamodb_table_item` usando los valores de `envs/<env>.tfvars` y `lifecycle { ignore_changes = [item] }`. Sin ese `ignore_changes`, el siguiente `terraform apply` revertiría los cambios hechos en caliente (P-13 en [09](09-analisis-especificacion.md)).
- **Lectura:** el paquete `packages/feature-flags` expone el puerto `FeatureFlagReader.isEnabled(key)` y un adaptador DynamoDB con **caché en memoria de 5 s**. Un cambio se refleja en ≤ 5 s **sin redesplegar**. Si DynamoDB no responde, se usa el último valor conocido; si no hay ninguno, el valor seguro por defecto (`false`).
- **Escritura:** solo por la mutación GraphQL `setFeatureFlag` (rol `platform-admins`). Escribe la flag con `version` condicional y un ítem `FlagAudit` en la misma transacción. Alternativa documentada para la demo: `scripts/flags/set.sh <env> <key> <true|false>`, que también deja auditoría.

### Flags y su evaluación

| Flag | Servicio que la evalúa | Semántica propuesta | `dev` | `test` | `prod` |
| --- | --- | --- | --- | --- | --- |
| `ENABLE_DYNAMIC_SURGE_PRICING` | billing-wallet | En las ventanas pico configuradas (p. ej. 17:00–21:00, America/Bogota) aplica `surgeMultiplier` (p. ej. 1,25) a la tarifa. | `true` | `true` | `false` |
| `ENABLE_FAST_CHARGE_BOOST` | station-reservation | Si está activa, una reserva con `fastChargeBoost=true` puede tomar conectores `ultraFast` (≥ 150 kW) y obtiene un *hold* extendido (300 s en vez de 120 s). Con la flag apagada, `fastChargeBoost=true` responde `403 FAST_CHARGE_BOOST_DISABLED`. Un conector `ultraFast` sin `fastChargeBoost` responde `409 ULTRA_FAST_REQUIRES_BOOST`. Implementado en `ReservationPolicy`. | `true` | `true` | `false` |
| `SIMULATE_CHARGER_HARDWARE_FAULT` | energy-dispatch (adaptador `SimulatedChargerAdapter`) | Fuerza `CHARGER_HARDWARE_FAULT` en la activación para demostrar el rollback de la SAGA. | `false` | `false` | `false` |

- La semántica de `ENABLE_FAST_CHARGE_BOOST` es una interpretación de una especificación ambigua (P-14).
- `SIMULATE_CHARGER_HARDWARE_FAULT` existe en los tres ambientes, como pide §2.2, pero empieza en `false` y solo un administrador puede cambiarla, con auditoría.
- El frontend muestra el estado efectivo de las flags (`query featureFlags`) y el nombre del ambiente (`query environment`) y los refresca por polling.

Demostración de §6.4:
1. Cambiar la flag en `dev` con la mutación o el script.
2. En ≤ 5 s, el frontend de `dev` muestra el nuevo estado y el comportamiento cambia (precio con *surge*).
3. `prod` sigue intacto: es otra tabla. Se comprueba con `aws dynamodb get-item` en `aegisvolt-feature-flags-prod`.

### Aislamiento de `dev`, `test` y `prod`

| Capa | Mecanismo de aislamiento |
| --- | --- |
| Estado de Terraform | Objeto distinto en S3 por workspace: `env:/<env>/aegisvolt/terraform.tfstate` |
| Recursos AWS | Sufijo `-${terraform.workspace}` en todos los nombres, y VPC y clúster EKS por ambiente |
| Datos | Tablas DynamoDB por ambiente, incluida la de flags |
| Identidad | Un User Pool de Cognito por ambiente; un token de `dev` no es válido en `prod` (issuer y audiencia distintos) |
| Cómputo | Clúster EKS por ambiente (`aegisvolt-<env>`) |
| Logs | Grupos `/aegisvolt/<env>/<service>` |
| Despliegue | La rama destino determina el ambiente (`dev`, `test`, `prod`); no hay forma de desplegar `feature/*` en `test` o `prod` |

En AWS real se recomendaría además una cuenta por ambiente (AWS Organizations). La especificación exige workspaces y Floci usa una sola cuenta (`000000000000`); esto se registra en [ADR-0011](../adr/0011-terraform-workspaces-backend-s3-bootstrap.md).

## 11. Autenticación y autorización

### Usuarios y roles

| Grupo Cognito | Quién | Permisos |
| --- | --- | --- |
| `fleet-operators` | Operador de una flota (`custom:fleet_id`) | Consultar estaciones, telemetría y flags. Iniciar SAGAs y ver la billetera y el historial **solo de su flota**. |
| `platform-admins` | Administrador de AegisVolt | Todo lo anterior para cualquier flota, más `setFeatureFlag` y `topUpWallet`. |

### Flujo

1. El SPA autentica contra el User Pool de su ambiente (`USER_PASSWORD_AUTH`, verificado en Floci) y obtiene un ID token RS256.
2. El SPA envía `Authorization: Bearer <token>` a API Gateway.
3. **Verificación en el GraphQL API** (siempre): firma con JWKS (`<issuer>/.well-known/jwks.json`), `iss`, `aud`, `exp` y `token_use`. Se implementa detrás del puerto `TokenVerifier`.
4. **En AWS real**, además, un *Cognito authorizer* en API Gateway rechaza tokens inválidos antes de que lleguen al clúster (defensa en profundidad).
5. **Autorización en el GraphQL API**, en una capa de políticas y no en los resolvers:
   - `fleet-operators` solo puede operar sobre `input.fleetId == token["custom:fleet_id"]`;
   - las mutaciones administrativas exigen `platform-admins`.

Verificado en Floci 2.4.0:
- `initiate-auth` emite un JWT con `cognito:groups` y `custom:fleet_id`.
- El JWKS se publica en `http://<host>:4566/<poolId>/.well-known/jwks.json`.
- El `iss` usa el hostname `floci` (`http://floci:4566/<poolId>`), que los pods resolverán mediante el Service `floci` ([ADR-0012](../adr/0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md)).
- **No verificado:** que API Gateway en Floci aplique un *Cognito authorizer*. Por eso la verificación en el GraphQL API es obligatoria y no opcional.

### Seguridad entre servicios

- Los servicios de dominio y el orquestador son `ClusterIP` y no tienen exposición externa.
- **NetworkPolicies:**
  - default-deny de ingress en el namespace;
  - el orquestador acepta tráfico solo del GraphQL API;
  - los servicios de dominio, solo del orquestador y del GraphQL API (para lecturas).
- El controlador de NetworkPolicies embebido en k3s se verificará en la fase de Kubernetes.
- No se usa mTLS ni service mesh: no lo exige la especificación y añadiría complejidad sin beneficio demostrable aquí (regla 10).
- **AWS real:** cada pod usa un rol IAM propio (IRSA o EKS Pod Identity, a decidir en la fase de IaC según el soporte verificado en Floci), restringido a su tabla.
- **Floci:** credenciales ficticias desde un Secret del overlay local. Floci no evalúa políticas IAM, lo que se registra como limitación.
- **Secretos:** ninguno en el repositorio. Los valores locales son ficticios y en AWS se usarían Secrets Manager o Pod Identity.
