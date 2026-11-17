# ADR-0002: Bounded contexts y orquestador de SAGA como servicio dedicado

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

La especificación (§2.2) exige al menos tres microservicios: `station-reservation-service`, `billing-wallet-service` y `energy-dispatch-service`, más una capa de agregación GraphQL. El flujo "Reservar y Activar Carga" atraviesa los tres y debe implementarse como SAGA (§2.3). La especificación no dice dónde vive la coordinación de esa SAGA. CLAUDE.md prohíbe la lógica de negocio en los resolvers.

## Decisión

Se definen cuatro bounded contexts de dominio y dos genéricos:

| Bounded context | Servicio |
| --- | --- |
| Charging Orchestration | `saga-orchestrator-service`, un **cuarto servicio** desplegable |
| Station Reservation | `station-reservation-service` |
| Billing & Wallet | `billing-wallet-service` |
| Energy Dispatch | `energy-dispatch-service` |
| Platform Configuration (flags) | módulo del GraphQL API |
| Identity | Cognito |

El GraphQL API es un BFF sin estado de negocio: autentica, autoriza, valida, compone lecturas y delega la mutación de la SAGA al orquestador.

## Alternativas

1. **Orquestación dentro del GraphQL API.** Ahorra un despliegue, pero mezcla el borde con la lógica del proceso, complica el `RecoveryWorker` en un componente pensado como *stateless* y viola la regla de resolvers sin lógica de negocio.
2. **Orquestación dentro de uno de los tres servicios** (p. ej. reservation). Acopla un contexto a los otros dos y le da dos responsabilidades.
3. **Coreografía por eventos.** Se descarta en [ADR-0003](0003-saga-orquestada-maquina-estados-persistente.md).
4. **AWS Step Functions** (Floci lo emula). Saca la lógica de los microservicios hacia un servicio gestionado y es menos demostrable como "código propio" en la sustentación. Queda como evolución posible.

## Consecuencias

- **Positivas:**
  - Responsabilidad única por componente.
  - El orquestador escala, se recupera y se despliega con canary de forma independiente.
  - El proceso se puede probar en aislamiento.
- **Negativas:**
  - Un servicio más que construir, desplegar y monitorear, con más memoria por ambiente (R-02).
  - El diagrama de la especificación muestra tres servicios; esta diferencia se explica en P-17.
