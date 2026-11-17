# Pruebas E2E

Pruebas de extremo a extremo ([ADR-0016](../../docs/adr/0016-estrategia-de-pruebas.md), [08-testing.md](../../docs/architecture/08-testing.md)).

## SAGA "Reservar y Activar Carga" (implementado)

`test/saga.e2e.test.ts` levanta los **cuatro servicios reales** (procesos Node, puertos 24100–24103) contra **Floci**:
- crea tablas temporales `aegisvolt-*-e2e-<sufijo>`;
- usa solo credenciales ficticias;
- rechaza endpoints que no sean locales.

| Escenario | Qué se verifica en DynamoDB |
| --- | --- |
| Éxito | Saga `COMPLETED`, reserva `CONFIRMED`, conector `OCCUPIED`, débito y movimiento, sesión `ACTIVE`, mismo `correlation_id` |
| Repetición de la petición inicial | Misma SAGA, un solo cobro |
| Fondos insuficientes | `COMPENSATED`, reserva `RELEASED`, débito `REJECTED_INSUFFICIENT_FUNDS`, saldo intacto |
| Fallo de hardware (flag en la tabla de flags) | `COMPENSATED`, sesión `FAILED` simulada, débito `REFUNDED` y `Refund`, reserva `RELEASED`, orden refund → release |
| Repetición de una compensación | `ALREADY_REFUNDED` / `ALREADY_RELEASED`, sin cambios de saldo ni de libro mayor |
| Reinicio con paso intermedio | `SIGKILL` con `DEBIT IN_PROGRESS` y el débito ya aplicado; un proceso nuevo la completa sin doble cobro |
| Fallo durante la compensación | `COMPENSATION_FAILED` (débito y reserva intactos); tras reiniciar el orquestador, `COMPENSATED` |

Los escenarios 5 y 6 usan un **proxy de inyección de fallos** delante de billing: retiene una respuesta o devuelve `503` en los reembolsos, sin tocar el código del servicio.

```bash
scripts/floci/start.sh
REQUIRE_INTEGRATION=true pnpm test:e2e     # sin Floci y sin REQUIRE_INTEGRATION se omiten
ls tests/e2e/.evidence/                    # JSON por escenario (summary + ítems completos) y logs
```

`E2E_KEEP_TABLES=true` conserva las tablas para inspeccionarlas con `aws dynamodb`. El análisis de la evidencia está en el [runbook](../../docs/runbooks/saga-demo.md).

## GraphQL API de punta a punta (implementado)

`test/graphql.e2e.test.ts` levanta además el **graphql-api** y crea en Floci un **User Pool de Cognito**: grupos, un administrador y dos operadores de flotas distintas con `custom:fleet_id`. Todas las peticiones llevan **ID tokens reales** emitidos por Cognito.

| Escenario | Qué se verifica |
| --- | --- |
| Autenticación | Sin token o con un token alterado → `UNAUTHENTICATED` |
| Consultas | Catálogo, billetera, flags (`environment: local`) |
| Autorización | Un operador no ve otra flota; un administrador sí; `updateFeatureFlag` solo para el administrador |
| `reserveAndActivateCharging` | SAGA `COMPLETED`; repetición con la misma clave = misma SAGA; `correlation_id` en los logs de los cinco procesos y en el libro mayor |
| Consultas de seguimiento | `sagaStatus` + eventos, `reservations`, `transactions`, `chargingSessions`, `chargingSessionById` |
| `releaseReservation` / `stopChargingSession` | `CONFLICT` con la carga activa; parada y liberación (conector `AVAILABLE`); liberación repetida `ALREADY_RELEASED` |
| Falla inducida por flag | El administrador activa `SIMULATE_CHARGER_HARDWARE_FAULT` por GraphQL → SAGA `COMPENSATED`, débito `REFUNDED`, saldo restituido |
| Validación | Entradas inválidas → `BAD_USER_INPUT` |

## Consola web en navegador (implementado)

`test/web.e2e.test.ts` (Chromium headless con `playwright-core` 1.62.1; usa el Chromium ya descargado en `~/.cache/ms-playwright`).

- **Montaje.** Compila `apps/web`. `src/web-console.ts` la sirve como el despliegue: estáticos, `config.json` del ambiente y proxies del mismo origen `/graphql` y `/auth/cognito`.
- **Escenarios:**

| Escenario | Qué se verifica |
| --- | --- |
| Credenciales inválidas | Cognito las rechaza y la consola muestra "Usuario o contraseña incorrectos" |
| Flujo exitoso | Login del operador, ambiente `LOCAL` visible, carga hasta `COMPLETED` y débito en Transacciones |
| Flujo fallido | El administrador activa `SIMULATE_CHARGER_HARDWARE_FAULT` desde la UI (persistida en DynamoDB, versión 2); el operador no puede editar flags; su carga termina `COMPENSATED`; en Observabilidad se ven el `correlation_id`, el plan `REFUND_DEBIT → RELEASE_RESERVATION` y los eventos; aparece el reembolso |

Capturas en `.evidence/web/`.

## Pendiente

Ejecutar estas suites contra un stack `docker compose` en el check `e2e-tests` de CI.
