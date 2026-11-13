# Pruebas E2E

Pruebas de extremo a extremo del flujo completo desde el frontend y la API ([ADR-0016](../../docs/adr/0016-estrategia-de-pruebas.md), [08-testing.md](../../docs/architecture/08-testing.md)).

Escenarios previstos:
- SAGA exitosa;
- fondos insuficientes;
- falla de hardware con la flag activada;
- doble envío con la misma `idempotencyKey`;
- flag cambiada en caliente;
- autorización por flota.

Se ejecutan contra un stack `docker compose` (Floci efímero + aplicaciones + SPA) en el check `e2e-tests` de CI. Se implementan cuando existan los flujos de negocio.
