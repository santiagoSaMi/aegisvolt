# ADR-0020: Modelos de dominio por bounded context y contratos de integración con Zod

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Relación:** precisa ADR-0004 (la forma del contrato es Zod; OpenAPI se derivará) y ADR-0016 (pruebas de contrato).

## Contexto

Hay que modelar nueve conceptos: Station, ChargingConnector, Reservation, Wallet, WalletTransaction, ChargingSession, TelemetryRecord, SagaTransaction y FeatureFlag. Los contratos HTTP entre servicios deben definirse con validación Zod, sin forzar un dominio compartido.

Las reglas vigentes:
- CLAUDE.md: el dominio no depende de librerías;
- ADR-0018: `domain-has-no-external-dependencies` y `domain-is-isolated` lo hacen cumplir;
- ADR-0005: idempotencia mediante IDs pre-generados y tombstones.

## Decisión

1. **Un modelo por bounded context,** en el `src/domain/` de su servicio y en TypeScript puro.
   - Los conceptos se reparten: Station, ChargingConnector y Reservation en station-reservation; Wallet, WalletTransaction (y Debit) en billing-wallet; ChargingSession y TelemetryRecord en energy-dispatch; SagaTransaction en saga-orchestrator; FeatureFlag en graphql-api.
   - **No hay *shared kernel*:** `DomainError`, los ids *branded* y los VO equivalentes se duplican a propósito en cada contexto. Así cada uno evoluciona y se despliega solo.
2. **Estilo del dominio:**
   - entidades inmutables con transiciones que devuelven instancias nuevas;
   - `restore()` valida invariantes al reconstruir;
   - errores con `code` estable;
   - servicios de dominio como funciones puras con *outcomes* explícitos;
   - tombstones como entidades propias.
   El dominio no conoce flags: recibe booleanos (`fastChargeBoostEnabled`, `surgePricingEnabled`) o el resultado de un puerto (`ChargerActivationResult`).
3. **Zod solo en los bordes.** `packages/contracts` contiene los esquemas Zod de los contratos públicos. Más adelante los usarán los adaptadores de `presentation/` (validar peticiones) e `infrastructure/` (validar respuestas). El dominio no usa Zod.
4. **Formato de los contratos:**
   - un módulo por API y versión (`stationReservationV1`, …), con `API`, `paths`, esquemas, vocabulario, `ERROR_CODES` y `problemSchema`;
   - identificadores con prefijo;
   - dinero en unidades menores;
   - fechas ISO en UTC;
   - peticiones estrictas (`z.strictObject`) y respuestas tolerantes (`z.object`).
   - **El servicio dueño de la regla decide los valores derivados.** Por ejemplo, la duración del *hold* la fija reservation y el importe del débito lo calcula billing; por eso el contrato **no** acepta `holdSeconds` ni un importe del cliente (ajuste respecto del borrador de 01-dominio).
5. **Versionado semántico** por contrato, con prefijo de ruta `/vN` y política de compatibilidad en [docs/contracts](../contracts/README.md#versionado). Cada cambio se registra en `packages/contracts/CHANGELOG.md`.
6. **Pruebas de alineación** (`test/domain/contract-alignment.test.ts`): como el dominio no puede importar el contrato, cada servicio verifica en sus pruebas que su vocabulario (estados, pasos, motivos) y sus códigos de error coinciden con el contrato publicado.
7. **OpenAPI** (ADR-0004) se **derivará** de los esquemas Zod cuando se implementen los endpoints (Zod 4 incluye `z.toJSONSchema`). No se mantiene a mano en paralelo.

## Alternativas

1. **Dominio compartido (`packages/domain`).** Menos duplicación, pero acopla los ciclos de vida de los servicios y contradice Database-per-Service y CLAUDE.md.
2. **Zod también en el dominio** (VO como esquemas). Es cómodo, pero rompe la regla de dominio sin dependencias y mezcla formato de red con invariantes de negocio.
3. **OpenAPI escrito a mano como fuente de verdad.** Requiere generar los tipos y validadores TypeScript; con Zod se tiene una sola definición ejecutable que produce tipos y validación.
4. **Estados `VOIDED` dentro de cada entidad.** Obligaría a que todos los campos de términos fueran opcionales y debilitaría las invariantes.

## Consecuencias

- **Positivas:**
  - Modelos explicables por contexto y probados unitariamente (transiciones, VO, invariantes).
  - Contratos validables y versionados.
  - La deriva entre dominio y contrato la detectan las pruebas.
- **Negativas:**
  - Código pequeño duplicado entre contextos (base de errores, ids, energía).
  - Hay que mantener sincronizados el vocabulario del dominio y el del contrato; lo vigilan las pruebas de alineación.
  - OpenAPI queda pendiente hasta la fase de endpoints.
