# ADR-0016: Estrategia de pruebas (unitarias, integración con Floci, contrato por OpenAPI compartido, E2E con compose)

- **Estado:** Aceptado
- **Fecha:** 2026-11-12
- **Relación:** precisado por [ADR-0020](0020-modelos-de-dominio-y-contratos-zod.md). Las pruebas de contrato validan contra los esquemas Zod compartidos, y se añaden pruebas de alineación entre dominio y contrato.

## Contexto

§3.3 exige unit, integration (contra DynamoDB y GraphQL) y e2e en cada PR. La regla 8 exige pruebas en todo comportamiento crítico. El usuario pidió pruebas de contrato. El CI hospedado no tiene acceso al Floci persistente.

## Decisión

- **Unitarias:** dominio y aplicación con *fakes* de los puertos, y reloj y aleatoriedad inyectados.
- **Integración:** adaptadores contra **Floci efímero**, con tablas de sufijo aleatorio por ejecución.
- **Contrato:** OpenAPI por servicio en `packages/contracts`, validado en el proveedor (respuestas reales) y en el consumidor (*fixtures* y *stubs*). Además, comparación del SDL GraphQL versionado.
- **E2E:** `docker compose` con Floci efímero, las seis apps y la SPA. Escenarios: éxito, fondos insuficientes, falla de hardware, doble envío, flag en caliente y autorización.
- **Infraestructura:** `fmt`, `validate`, `plan` y `terraform test` con aserciones sobre el plan.
- **Post-deploy:** smoke y análisis canary sobre el ambiente.
- La lista de casos críticos está en [08-testing.md](../architecture/08-testing.md). Las librerías se fijan en ADR al implementar.

## Alternativas

1. **Pact con broker** para contratos. Más potente entre equipos, pero añade un broker y binarios nativos para un único autor (regla 10).
2. **Mocks de DynamoDB en memoria** en lugar de Floci. Más rápidos, pero no detectan errores reales de expresiones condicionales o transacciones.
3. **E2E sobre k3s en el PR.** Más fiel, pero lento y pesado en runners hospedados. El despliegue real en K8s se valida post-merge.

## Consecuencias

- **Positivas:** confianza en las garantías críticas (idempotencia, compensaciones, aislamiento por flag) con dependencias reales emuladas, y pipeline reproducible.
- **Negativas:**
  - Las pruebas de integración y E2E dependen de Docker en el runner.
  - Los OpenAPI deben mantenerse al día.
  - El E2E de los PR no ejercita K8s ni API Gateway (cubierto post-merge).
