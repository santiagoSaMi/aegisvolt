# Guía de uso del GraphQL API

Punto de entrada único de AegisVolt (BFF). Diseño: [ADR-0026](../adr/0026-graphql-api-apollo-bff-autenticacion-resiliencia.md). Esquema documentado: [`apps/graphql-api/src/presentation/graphql/schema.ts`](../../apps/graphql-api/src/presentation/graphql/schema.ts). En `local`, `dev` y `test` también se puede consultar por introspección; en `prod` está deshabilitada.

- **Endpoint:** `POST /graphql` (puerto 4000 en local). Probes: `GET /health/live` y `GET /health/ready`.
- **Cabeceras:**
  - `Content-Type: application/json`, obligatoria por la protección CSRF;
  - `Authorization: Bearer <ID token de Cognito>`;
  - `x-correlation-id: <uuid>`, opcional: si no llega o no es un UUID, se crea uno. Se devuelve en la respuesta y viaja a todos los servicios.
- **Ambiente:** ninguna operación lo recibe. Es el del despliegue que responde (`featureFlags { environment }`).

## 1. Ejecutar en local contra Floci

```bash
scripts/floci/start.sh
pnpm build:packages
# Tablas de los servicios y flags (ver cada README) y los cuatro servicios en marcha (pnpm dev)
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

# User Pool del ambiente local: atributo custom:fleet_id, client y grupos
POOL=$(aws cognito-idp create-user-pool --pool-name aegisvolt-local \
  --schema Name=fleet_id,AttributeDataType=String,Mutable=true --query UserPool.Id --output text)
CLIENT=$(aws cognito-idp create-user-pool-client --user-pool-id $POOL --client-name graphql-api \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH --query UserPoolClient.ClientId --output text)
for g in fleet-operators platform-admins; do aws cognito-idp create-group --user-pool-id $POOL --group-name $g; done

# Un operador de la flota fleet_demo (contraseña de ejemplo, solo local)
aws cognito-idp admin-create-user --user-pool-id $POOL --username operador1 \
  --user-attributes Name=custom:fleet_id,Value=fleet_demo --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id $POOL --username operador1 --password 'Local-Passw0rd!' --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username operador1 --group-name fleet-operators

# apps/graphql-api/.env (copiado de .env.example): COGNITO_ISSUER=http://floci:4566/$POOL,
# COGNITO_JWKS_URL=http://localhost:4566/$POOL/.well-known/jwks.json, COGNITO_CLIENT_ID=$CLIENT
pnpm --filter @aegisvolt/graphql-api dev

TOKEN=$(aws cognito-idp initiate-auth --client-id $CLIENT --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=operador1,PASSWORD='Local-Passw0rd!' --query AuthenticationResult.IdToken --output text)
curl -s localhost:4000/graphql -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"query":"{ featureFlags { environment flags { key enabled } } }"}'
```

Prueba automática de todo el flujo (Floci, Cognito, los cinco procesos): `REQUIRE_INTEGRATION=true pnpm test:e2e`.

## 2. Consultas

```graphql
# Catálogo (cualquier usuario autenticado)
query Catalogo {
  stations(city: "medellin") { stationId name location { latitude longitude }
    connectors { connectorId type maxPowerKw status availableForReservation } }
  stationById(stationId: "st_gql-norte-01") { name connectors { connectorId status } }
  availableConnectors(stationId: "st_gql-norte-01") { stationName connector { connectorId maxPowerKw } }
}

# Datos de la flota (operador: la de su token; administrador: indicar fleetId)
query MiFlota {
  walletBalance { fleetId balance { amountMinor currency } updatedAt }
  transactions(first: 10) {
    items { type amount { amountMinor currency } balanceAfter { amountMinor } sagaId correlationId occurredAt }
    pageInfo { endCursor hasNextPage }
  }
  reservations(first: 10) { items { reservationId status connectorId holdExpiresAt } pageInfo { endCursor hasNextPage } }
}

# Página siguiente: pasar pageInfo.endCursor como after
query Siguiente($after: String) { transactions(first: 10, after: $after) { items { type } pageInfo { endCursor hasNextPage } } }

# Sesiones de carga y telemetría
query Sesiones {
  chargingSessions(stationId: "st_gql-norte-01", active: true) {
    items { sessionId connectorId status energyDeliveredKwh startedAt }
  }
  chargingSessionById(sessionId: "ses_…") {
    status requestedEnergyKwh fault { code simulated }
    telemetry(last: 5) { timestamp voltageV currentA powerKw energyKwh }
  }
}

# Estado de una SAGA y su historial (panel de compensaciones)
query Saga($sagaId: ID!) {
  sagaStatus(sagaId: $sagaId) {
    status terminal failureReason compensationPlan
    compensationFailure { step errorCode nextAttemptAt }
    steps { step status attempts lastErrorCode }
    events { sequence type step status errorCode occurredAt }
  }
}

# Feature flags del ambiente
query Flags { featureFlags { environment degraded readAt flags { key enabled source version updatedBy } } }

# Consola web: identidad y ambiente (lo informa el backend; el cliente no lo elige)
query Viewer { viewer { subject groups fleetId isAdmin environment } }

# Monto estimado por billing (tarifa, recargo dinámico y saldo) antes de iniciar la SAGA
query Estimate { chargingEstimate(stationId: "st_demo-01", connectorId: "cn_01", requestedEnergyKwh: 30) {
  connectorPowerKw estimated { amountMinor currency } available { amountMinor currency }
  sufficient tariffMinorPerKwh surgeApplied surgeMultiplierBasisPoints } }

# SAGAs recientes de la flota (filtro opcional por estado) y salud de los servicios
query Ops { sagas(status: COMPENSATED, first: 20) { sagaId status failureReason correlationId compensationPlan }
  systemStatus { checkedAt services { service ready latencyMs } } }
```

## 3. Mutaciones

```graphql
# Inicia la SAGA (reserva → cobro → activación). idempotencyKey: UUID generado por el cliente;
# repetir la mutación con la misma clave devuelve la misma SAGA (sin doble cobro).
mutation Cargar {
  reserveAndActivateCharging(input: {
    idempotencyKey: "0f5e2a3c-8b1d-4c6e-9a7f-2b3c4d5e6f70"
    stationId: "st_gql-norte-01"
    connectorId: "cn_01"
    requestedEnergyKwh: 30
  }) {
    finished                       # false → seguir con sagaStatus (polling)
    saga { sagaId status failureReason reservationId sessionId correlationId }
  }
}

# Detiene la carga de la flota y libera el conector
mutation Parar { stopChargingSession(sessionId: "ses_…") { outcome reservationOutcome session { status stopReason } } }

# Libera una reserva (no si la SAGA está en curso ni con la carga activa)
mutation Liberar { releaseReservation(reservationId: "res_…") { outcome reservation { status } } }

# Solo platform-admins: cambia una flag del ambiente (auditado)
mutation Flag {
  updateFeatureFlag(input: { key: "SIMULATE_CHARGER_HARDWARE_FAULT", enabled: true, expectedVersion: 1 }) {
    changed flag { key enabled version } change { from to changedBy changedAt environment correlationId }
  }
}
```

Demostración de §6.3:
1. Un administrador activa `SIMULATE_CHARGER_HARDWARE_FAULT`.
2. Un operador ejecuta `reserveAndActivateCharging`.
3. La SAGA termina `COMPENSATED` con `failureReason: CHARGER_HARDWARE_FAULT`: el débito se reembolsa y la reserva se libera.

Los ítems de DynamoDB se inspeccionan como en el [runbook de la SAGA](../runbooks/saga-demo.md).

## 4. Errores

```json
{
  "errors": [{
    "message": "No puede operar sobre otra flota",
    "path": ["walletBalance"],
    "extensions": { "code": "FORBIDDEN", "correlationId": "3f2c1e5a-…" }
  }]
}
```

| `extensions.code` | Cuándo | `reason` (ejemplos) |
| --- | --- | --- |
| `UNAUTHENTICATED` | Sin token, token inválido, vencido o de otro ambiente | — |
| `FORBIDDEN` | Otra flota; mutación administrativa sin `platform-admins` | — |
| `BAD_USER_INPUT` | Ids, rangos o paginación inválidos (`extensions.fields`) | — |
| `NOT_FOUND` | Recurso inexistente (en `…ById` y `sagaStatus` → `null`) | — |
| `CONFLICT` | Regla del BFF o rechazo de un servicio | `SAGA_IN_PROGRESS`, `CHARGING_SESSION_ACTIVE`, `CONNECTOR_UNAVAILABLE`, `FEATURE_FLAG_VERSION_CONFLICT` |
| `SERVICE_UNAVAILABLE` | Un servicio no respondió (tras el reintento permitido) | — |
| `GRAPHQL_VALIDATION_FAILED` / `GRAPHQL_PARSE_FAILED` | Documento inválido o demasiado profundo (> 8) | — |
| `INTERNAL_SERVER_ERROR` | Error no controlado: mensaje genérico; el detalle solo en el log con el `correlationId` | — |

Las respuestas nunca incluyen *stack traces* ni mensajes internos.

## 5. Límites

- `first`: 1–50 (por defecto 20).
- `telemetry(last)`: 1–100.
- `requestedEnergyKwh`: mayor que 0 y hasta 500, con resolución de 1 Wh.
- Profundidad máxima del documento: 8.
- Cuerpo: 64 KB.
- Importes: `SafeInt` en unidades menores (sin coma flotante).
