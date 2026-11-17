# billing-wallet-service

Microservicio de **billeteras de flota, cobros y reembolsos** (bounded context *Billing & Wallet*). Tiene persistencia propia en DynamoDB (`aegisvolt-billing-<env>`) y arquitectura hexagonal. Decisiones: [ADR-0022](../../docs/adr/0022-billing-wallet-ledger-atomico-y-compensaciones.md). Contrato: `billingWalletV1` (1.1.0) en [`packages/contracts`](../../packages/contracts/src/billing-wallet/v1.ts), documentado en [docs/contracts](../../docs/contracts/README.md#billing-wallet-v1).

## Responsabilidades y endpoints

| Responsabilidad | Endpoint | Caso de uso |
| --- | --- | --- |
| Administrar billeteras | `PUT /v1/wallets/{fleetId}` (abrir, saldo 0) · `PUT /v1/wallets/{fleetId}/top-ups/{topUpId}` (recarga) | `OpenWallet`, `TopUpWallet` |
| Consultar saldo | `GET /v1/wallets/{fleetId}` | `GetWalletBalance` |
| Verificar fondos | `GET /v1/wallets/{fleetId}/funds-check?energyKwh=&connectorPowerKw=` | `VerifyFunds` |
| Debitar el monto estimado | `PUT /v1/debits/{debitId}` (SAGA) · `POST /v1/debits` + `idempotency-key` | `DebitWallet` |
| Consultar un débito | `GET /v1/debits/{debitId}` | `GetDebit` |
| Reembolsar (compensación) | `POST /v1/debits/{debitId}/refund` | `RefundWallet` |
| Historial (libro mayor) | `GET /v1/wallets/{fleetId}/transactions?limit=&cursor=` | `GetTransactionHistory` |
| Probes | `GET /health/live`, `GET /health/ready` | — |

## Requisitos críticos y cómo se cumplen

| # | Requisito | Implementación |
| --- | --- | --- |
| 1 | Saldo nunca negativo | `Money` no admite negativos; `Wallet.debit` exige fondos; en DynamoDB, condición `balanceMinor >= :importe` |
| 2 | Movimientos auditables | Libro mayor *append-only* (`WalletTransaction`) con saldo resultante, operación, SAGA, `correlationId` e `idempotencyKey`; débitos rechazados y tombstones también se registran |
| 3 | Débito repetido no cobra dos veces | El id del débito es la clave: con los mismos términos → `200` sin escribir; con otros → `409`. Débito y movimiento con `attribute_not_exists` |
| 4 | Reembolso repetido no reembolsa dos veces | Transacción condicionada a `status = DEBITED` + versión; `Refund` único por débito (`rfd_…`) |
| 5 | Saldo y movimiento atómicos | Un `TransactWriteItems` por operación (saldo + operación + movimiento) |
| 6 | Compensación independiente y trazable | Entidad `Refund` con id, motivo, importe y auditoría propios, y su movimiento `REFUND` |
| 7 | `saga_id`, `correlation_id`, `operation_id`, idempotency key | `OperationAudit` en cada operación y movimiento; GSI1 por SAGA; logs JSON con `correlation_id` y `saga_id` |
| 8 | Enteros, sin coma flotante | Importes en unidades menores (`amountMinor`) de la moneda configurada (`WALLET_CURRENCY`); precio con `BigInt` y redondeo half-up |
| 9 | Concurrencia con condiciones explícitas | Versión de billetera y débito en cada escritura; reintento optimista (3) y luego `503` |
| 10 | El cliente no fija saldos ni resultados | El importe lo calcula `PricingPolicy`; las billeteras abren con saldo 0; cuerpos estrictos (`amount` o `balance` extra → `400`) |

Además, solo la SAGA dueña del débito puede reembolsarlo (`409 DEBIT_MISMATCH`), y reembolsar un débito inexistente deja un tombstone (`VOIDED`) que bloquea un cobro tardío.

## Estructura

```text
src/
  domain/           Wallet, Money, WalletTransaction, Debit, Refund, TopUp, OperationAudit, PricingPolicy
  application/      DebitWallet, RefundWallet, GetWalletBalance, VerifyFunds, GetTransactionHistory,
                    OpenWallet, TopUpWallet, GetDebit · puertos · reintento optimista
  infrastructure/   AWS SDK v3 con timeouts, repositorio DynamoDB (transacciones), readiness, lector de flags (DynamoDB con caché, ADR-0025)
  presentation/     Express 5: rutas delgadas, validación con el contrato, middleware común
  config.ts · composition.ts · main.ts
scripts/create-local-table.ts   tabla en Floci para desarrollo (rechaza endpoints no locales)
```

## Ejecutar en local (Floci)

```bash
scripts/floci/start.sh
cp services/billing-wallet/.env.example services/billing-wallet/.env
pnpm build:packages
pnpm --filter @aegisvolt/billing-wallet-service db:create-local-table
pnpm --filter @aegisvolt/billing-wallet-service dev        # http://localhost:4102
```

## Pruebas

```bash
pnpm --filter @aegisvolt/billing-wallet-service test               # dominio, aplicación, HTTP
pnpm --filter @aegisvolt/billing-wallet-service test:integration   # DynamoDB de Floci
```

| Suite | Casos clave |
| --- | --- |
| `test/domain` | Money, Energy, precios con surge, Wallet, ids derivados, débito, reembolso, recarga, alineación con el contrato |
| `test/application` | Fondos insuficientes (rechazo auditable, saldo intacto), débito duplicado, débitos simultáneos con saldo para uno, reembolso duplicado y simultáneo, reembolso de débito inexistente, `DEBIT_MISMATCH`, atomicidad ante fallos persistentes, historial paginado |
| `test/presentation` | Códigos HTTP, `problem+json`, el cliente no puede fijar saldo ni importe, `idempotency-key`, concurrencia `201`/`422`, timeout `503`, `500` sin detalles |
| `test/integration` | Ítems reales en Floci: débito atómico con auditoría, duplicado, fondos insuficientes, **8 débitos simultáneos con saldo para 3**, reembolso como operación propia, **3 reembolsos simultáneos → 1 aplicado**, tombstone, `DEBIT_MISMATCH`, **atomicidad** (versión obsoleta o débito ya existente → nada escrito), historial paginado y GSI por SAGA |

## Limitaciones y pendientes

- **Flags:** `ENABLE_DYNAMIC_SURGE_PRICING` se lee de `aegisvolt-feature-flags-<env>` (tabla derivada de `APP_ENV`, caché de 5 s, valor seguro `false`). Un cambio se refleja en ≤ 5 s sin reiniciar ([runbook](../../docs/runbooks/feature-flags-demo.md)).
- **Autorización:** no hay autorización por rol en recargas ni aperturas. El servicio es interno; el GraphQL API aplica los roles (ADR-0008).
- **Verificación de fondos:** es una consulta y no retiene saldo (P-08). El débito vuelve a comprobarlo de forma atómica.
- **Contenedor:** el Dockerfile llega en la fase de Kubernetes; la tabla de cada ambiente, en la fase de IaC.
