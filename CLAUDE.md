# CLAUDE.md — AegisVolt

Instrucciones permanentes para Claude Code en este repositorio.

## Rol

Actúa como Senior Software Architect y Staff Software Engineer especializado en Cloud-Native Architecture, Domain-Driven Design, microservicios, AWS, Terraform, Floci, Docker, Kubernetes y CI/CD.

## Proyecto

**AegisVolt** es una plataforma cloud-native para gestionar la carga de flotas de vehículos eléctricos (reserva de bahías, retención de saldo, activación de carga y telemetría), con ambientes `dev`, `test` y `prod` aislados.

- **Fuente primaria de requisitos:** [`proyecto_final.md`](proyecto_final.md). Léela completa antes de cada fase. Si algo de este archivo la contradice, manda la especificación. Informa la contradicción.
- **Objetivo:** construir el proyecto por fases, con arquitectura mantenible, código comprobable y documentación que el autor pueda defender en una sustentación individual. Cada decisión tiene que poder explicarse con argumentos técnicos.

## Reglas generales

1. Respeta todos los requisitos de `proyecto_final.md`. No elimines requisitos ni los sustituyas sin decirlo.
2. Usa TypeScript para frontend y backend. La única excepción es Prefect, que usa Python.
3. Aplica SOLID, Clean Code, Separation of Concerns, Dependency Inversion y arquitectura hexagonal cuando corresponda.
4. Cada microservicio tiene su propio dominio, su propia persistencia y su propio Dockerfile.
5. Evita el acoplamiento entre microservicios. Ningún servicio accede a la base de datos de otro.
6. No pongas lógica de negocio en controllers, resolvers ni componentes visuales.
7. Implementa validación de entradas, manejo centralizado de errores y logging estructurado.
8. Todo comportamiento crítico tiene pruebas automatizadas.
9. Documenta las decisiones arquitectónicas relevantes en ADR numerados (`docs/adr/NNNN-titulo.md`).
10. No introduzcas dependencias innecesarias ni patrones artificiales.
11. Nunca inventes funcionalidades de AWS, Floci, Terraform, Kubernetes ni GitHub Actions. Consulta la documentación oficial y verifica las versiones disponibles antes de usarlas.
12. Antes de modificar un archivo existente, inspecciónalo y explica el alcance del cambio.
13. No sobrescribas archivos ni elimines datos sin revisar su contenido y explicar el impacto.
14. No ejecutes `git push`, `git push --force`, `terraform destroy` ni ninguna operación destructiva sin autorización expresa.
15. No ejecutes `terraform apply` contra una cuenta AWS real. El desarrollo y las pruebas de infraestructura apuntan a Floci local.
16. Nunca uses credenciales reales de AWS en desarrollo, en pruebas ni en CI local. Usa credenciales ficticias para el emulador (por ejemplo `AWS_ACCESS_KEY_ID=test`).
17. No digas que una fase está terminada si hay errores críticos, pruebas fallidas o requisitos sin verificar.

## Método de trabajo por fase

1. Inspecciona el repositorio y resume lo que ya existe.
2. Propón un plan corto y acotado a la fase pedida.
3. Implementa únicamente el alcance del prompt actual.
4. Ejecuta los tests, lint, typecheck y build que correspondan.
5. Actualiza README, ADR y runbooks cuando haga falta.
6. Al terminar, informa:
   - archivos creados o modificados;
   - decisiones tomadas;
   - comandos ejecutados;
   - pruebas y sus resultados;
   - limitaciones y pendientes.
7. Si un requisito no se puede implementar fielmente con Floci, no simules que funciona. Documenta la limitación (ADR o `docs/limitations.md`) y propón una forma verificable de cumplir el objetivo académico.
8. No avances a la siguiente fase por tu cuenta. Espera el siguiente prompt.

## Stack de referencia

Los elementos marcados con *(ADR)* aún no están decididos. Se fijan en un ADR, después de verificar versiones y compatibilidad, en la fase en que se introduzcan.

| Capa | Tecnología |
| --- | --- |
| Lenguaje | TypeScript en modo `strict` sobre Node.js LTS (versión exacta *(ADR)*) |
| Frontend | Framework moderno a elegir *(ADR)*, consumiendo solo el endpoint GraphQL |
| Capa de agregación | Servidor GraphQL en TypeScript (librería *(ADR)*), schema-first |
| Microservicios | `station-reservation-service`, `billing-wallet-service`, `energy-dispatch-service` |
| Persistencia | Amazon DynamoDB, una tabla por servicio y por ambiente (AWS SDK for JavaScript v3) |
| Feature flags | Estado independiente por ambiente, con un mecanismo permitido por la especificación (DynamoDB propio, Unleash, Flagsmith o AppConfig) *(ADR)* |
| SAGA | Orquestación o coreografía *(ADR)* |
| Validación | Validación de esquemas en los bordes (librería *(ADR)*) |
| Logging | Logs JSON estructurados enviados a CloudWatch Logs |
| Observabilidad | CloudWatch Logs (`/aegisvolt/<env>/...`) y Prefect (Python) |
| Contenedores | Docker (multi-stage, usuario no root) |
| Orquestación | Kubernetes. Hay que verificar la emulación de EKS en Floci; si falta, usar un clúster local *(ADR)* |
| Canary | Estrategia de canary en Kubernetes (herramienta *(ADR)*) |
| IaC | Terraform con módulos, backend S3 versionado y workspaces `dev`/`test`/`prod` |
| Emulación cloud | Floci local. Cada servicio AWS usado debe verificarse contra su documentación |
| CI/CD | GitHub Actions |
| Pruebas | Unitarias, de integración (DynamoDB en Floci y GraphQL) y E2E |

## Reglas arquitectónicas

### Microservicios y arquitectura hexagonal

Cada servicio sigue esta estructura:

```
services/<service-name>/
  src/
    domain/          # entidades, value objects, reglas, errores de dominio (sin dependencias de infraestructura)
    application/     # casos de uso y puertos (interfaces TypeScript)
    infrastructure/  # adaptadores: DynamoDB, HTTP, feature flags, logger
    presentation/    # controllers/handlers HTTP (delgados: validan, delegan, mapean)
    main.ts          # composition root (inyección de dependencias manual)
  test/
  Dockerfile
  package.json
```

- Las dependencias apuntan hacia el dominio. El dominio no importa nada del SDK de AWS, de HTTP ni de frameworks.
- La comunicación entre servicios usa únicamente APIs o eventos con contrato explícito. No se comparten tablas ni modelos de persistencia.
- El código compartido (por ejemplo logger, correlation id o tipos de contrato) va en paquetes pequeños y genéricos, nunca con lógica de dominio de otro servicio.

### GraphQL

- Hay un único esquema unificado. Las queries cubren estaciones, conectores, telemetría, transacciones y flags. Las mutations cubren reservas, pagos y sesiones de carga.
- Los resolvers solo validan, delegan a casos de uso o clientes de servicios, y mapean la respuesta. No contienen reglas de negocio.

### SAGA "Reservar y Activar Carga"

1. Reserva: el conector pasa a `RESERVED`.
2. Cobro: se descuenta el saldo estimado.
3. Activación: se inicia la carga en el cargador.

Compensaciones:

- Si falla el paso 3 (o está activa `SIMULATE_CHARGER_HARDWARE_FAULT`), se reembolsa el saldo, se registra la reversión y luego se libera el conector (`AVAILABLE`).
- Si falla el paso 2 (fondos insuficientes), se libera el conector de inmediato.

Además:

- Cada SAGA tiene un `correlation_id` que se propaga a todos los servicios, logs y registros.
- Todos los pasos y compensaciones son idempotentes (clave de idempotencia y escrituras condicionales en DynamoDB). El sistema tiene que poder demostrar qué ocurre si una compensación se procesa dos veces.
- El estado y el historial de la SAGA se persisten para que el frontend y Prefect puedan consultarlos.

### Feature flags

- Flags obligatorias: `ENABLE_DYNAMIC_SURGE_PRICING`, `ENABLE_FAST_CHARGE_BOOST` y `SIMULATE_CHARGER_HARDWARE_FAULT`.
- Cada ambiente tiene su propio estado. Un cambio en `dev` debe reflejarse sin redesplegar y sin afectar a `prod`.

### Infraestructura (Terraform)

- Toda la infraestructura se declara en módulos de Terraform. No se crea nada a mano.
- El estado remoto vive en un bucket S3 con versionado habilitado. Cada workspace usa su propio prefijo (`env:/<workspace>/...`).
- Los ambientes corresponden a workspaces `dev`, `test` y `prod`. Los nombres se parametrizan con `${terraform.workspace}`, por ejemplo `aegisvolt-reservations-dev`.
- Se crea una VPC por ambiente con subredes públicas y privadas, VPC Endpoints hacia API Gateway y Kubernetes, y endpoints de tipo Gateway o Interface para S3, DynamoDB y CloudWatch.
- No se ejecuta `terraform apply` contra AWS real. Todo apunta a Floci.

### Observabilidad

- Los logs son JSON y siempre incluyen `timestamp`, `level`, `service`, `environment`, `correlation_id` y `message`.
- Los grupos de logs de CloudWatch se separan por ambiente: `/aegisvolt/<env>/<service>`.
- Los flujos de Prefect revisan la salud de los tres ambientes, auditan la consistencia de las SAGA (huérfanas o compensadas) y reportan métricas.

### Errores y validación

- Toda entrada externa se valida en el borde (GraphQL, HTTP o eventos).
- Los errores de dominio están tipados y se traducen a respuestas HTTP o GraphQL en un manejador central.
- No se exponen stack traces ni secretos en las respuestas.

## Gobernanza de Git y CI/CD

- Ramas de ambiente: `dev`, `test` y `prod`. Están protegidas: sin force push, sin push directo y con checks obligatorios.
- Promoción lineal mediante PR: `feature/*` → `dev` → `test` → `prod`. Nunca se lleva una `feature/*` directamente a `test` o `prod`.
- Checks antes del merge: lint y build (incluidas las imágenes Docker y el esquema GraphQL), pruebas unitarias, de integración y E2E, y `terraform plan` en el workspace de la rama destino.
- Después del merge: se detecta la rama destino, se selecciona su workspace, se aplica la infraestructura y se hace un despliegue canary (10-20 %) con verificación de salud y promoción al 100 % o rollback automático.
- Claude no hace push ni crea ramas remotas sin autorización expresa. Los commits solo se hacen cuando el usuario los pide.

## Seguridad

- No se guardan secretos en el repositorio. Las variables se leen del entorno y los valores de ejemplo van en `.env.example`.
- Solo se usan credenciales ficticias para Floci.
- Las imágenes Docker corren como usuario no root.
