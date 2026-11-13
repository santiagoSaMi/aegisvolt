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

## Pendiente

Flujo completo desde el frontend y la API GraphQL (autorización por flota, flag cambiada en caliente vista en la SPA), contra un stack `docker compose` en el check `e2e-tests` de CI.
