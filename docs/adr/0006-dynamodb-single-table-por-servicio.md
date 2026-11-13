# ADR-0006: Database-per-Service con una tabla DynamoDB *single-table* por servicio y ambiente

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.4 exige DynamoDB, el patrón Database-per-Service y separación por ambiente (`aegisvolt-reservations-dev`, etc.). Cada servicio tiene varias entidades relacionadas que deben actualizarse de forma atómica: conector y reserva; billetera, débito y libro mayor.

## Decisión

- **Una tabla por servicio y ambiente:**
  - `aegisvolt-sagas-<env>`
  - `aegisvolt-reservations-<env>`
  - `aegisvolt-billing-<env>`
  - `aegisvolt-dispatch-<env>`
  - `aegisvolt-feature-flags-<env>`
- **Diseño *single-table*** con `PK`/`SK` genéricos y GSIs para cada patrón de acceso:
  - sagas: por flota y por estado;
  - reservations: por ciudad;
  - billing: por saga;
  - dispatch: por conector.
  - El detalle está en [01-dominio-y-servicios.md](../architecture/01-dominio-y-servicios.md).
- **Atributos comunes:** `version` para concurrencia optimista; dinero en enteros de unidades menores.
- **Vencimiento del *hold*** de la reserva evaluado en la condición de escritura. No se depende del TTL de DynamoDB, que no garantiza borrado inmediato.
- `PAY_PER_REQUEST`, PITR y `deletion_protection_enabled` en `prod` (ambas opciones verificadas en Floci).
- **IAM:** cada servicio solo puede acceder a su tabla. Excepciones de solo lectura: la tabla de flags ([ADR-0007](0007-feature-flags-dynamodb-por-ambiente.md)) y Prefect ([ADR-0014](0014-observabilidad-cloudwatch-fluent-bit-prefect.md)).

## Alternativas

1. **Una tabla por entidad.** Más fácil de leer, pero impide `TransactWriteItems` entre entidades del mismo servicio sin cruzar tablas, multiplica los recursos de Terraform y no aporta ventajas.
2. **Una tabla compartida para todos los servicios con prefijos.** Viola Database-per-Service.
3. **Escaneos (`Scan`) para los paneles.** Simple, pero no escala y es una mala práctica que se puede cuestionar en la defensa.

## Consecuencias

- **Positivas:** operaciones atómicas por servicio, consultas eficientes y aislamiento por ambiente y por servicio.
- **Negativas:** el diseño *single-table* exige documentar bien los patrones de acceso. Algunos GSI de baja cardinalidad, como `STATUS#<status>`, pueden concentrar carga; es aceptable en este volumen y está documentado.
