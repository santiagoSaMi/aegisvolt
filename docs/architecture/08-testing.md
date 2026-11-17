# 08 · Estrategia de pruebas

Cubre el punto 18. Decisión: [ADR-0016](../adr/0016-estrategia-de-pruebas.md). Las librerías concretas (runner de pruebas, cliente HTTP de pruebas, Playwright, etc.) se fijan en ADR al implementar.

| Nivel | Qué cubre | Dependencias reales | Dónde corre | Check de CI |
| --- | --- | --- | --- | --- |
| **Unitarias** | Dominio y aplicación de cada servicio, con *fakes* de los puertos | Ninguna | Hospedado | `unit-tests` |
| **Integración** | Adaptadores: repositorios DynamoDB, lector de flags, handlers HTTP, resolvers GraphQL con clientes simulados | Floci efímero (DynamoDB, Logs, Cognito) | Hospedado | `integration-tests` |
| **Contrato** | Consumidor (GraphQL, orquestador) ↔ proveedor (servicios) | Ninguna | Hospedado | parte de `integration-tests` |
| **E2E** | Flujo completo desde el SPA y la API | Floci efímero + contenedores de todas las apps (compose) | Hospedado | `e2e-tests` |
| **Infraestructura** | Terraform | Floci persistente (plan) | Self-hosted | `terraform-plan` |
| **Post-deploy** | Smoke y canary en el ambiente real | Ambiente desplegado | Self-hosted | job de CD |

## Casos críticos (regla 8: todo comportamiento crítico tiene pruebas)

### Unitarias
- **Máquina de estados de la SAGA:**
  - cada transición válida;
  - rechazo de transiciones inválidas;
  - orden inverso de compensaciones;
  - `COMPENSATION_FAILED` con reintento programado o, al agotar las rondas o ante un error no recuperable, a la espera de un reintento controlado (ADR-0024);
  - decisión en el pivote (`ACTIVE` → confirmar; desconocido → compensar);
  - `SAGA_FORWARD_DEADLINE` en recuperación.
- **Política de reintentos:** reintenta solo ante errores transitorios; nunca ante `409`/`422`; backoff con jitter determinista (`Random` inyectado).
- **Billing:** cálculo con y sin *surge* (reloj inyectado en ventana pico y fuera de ella), dinero en unidades menores, saldo insuficiente.
- **Reservation:** reglas de disponibilidad, vencimiento perezoso del *hold*, `ENABLE_FAST_CHARGE_BOOST`.
- **Dispatch:** `SimulatedChargerAdapter` con la flag encendida y apagada.
- **GraphQL:** políticas de autorización (flota del token frente a `input.fleetId`; rol admin).

### Integración (Floci, tablas con sufijo aleatorio por ejecución)
- Débito idempotente: el mismo `PUT` dos veces deja un solo débito y una sola entrada de libro mayor.
- **Reembolso doble:** el segundo `refund` devuelve `ALREADY_REFUNDED` y el saldo no cambia (pregunta §6.3).
- **Compensación antes del avance:** `refund` sobre un débito inexistente crea un tombstone y el `PUT` posterior devuelve `409 DEBIT_VOIDED`. Lo mismo para la reserva y la sesión.
- **Concurrencia:** dos `PUT /reservations` simultáneos sobre el mismo conector dejan exactamente uno `HELD`.
- Saga y SagaEvent atómicos: la escritura condicional falla con una `version` obsoleta.
- **RecoveryWorker:** una SAGA "abandonada" con el débito `IN_PROGRESS` se recupera, y el *lease* impide que dos workers la procesen.
- **E2E de la SAGA** (`pnpm test:e2e`): los cuatro servicios reales contra Floci, con la evidencia de DynamoDB del [runbook](../runbooks/saga-demo.md).
- **Feature flags:** un cambio en la tabla se refleja tras el TTL de la caché; el valor por defecto se usa si la tabla no está disponible.
- **Logs:** el JSON contiene los campos obligatorios y la propagación de `correlation_id` (a nivel de proceso; el envío a CloudWatch se prueba en la fase de observabilidad).
- **Verificación de JWT** contra un User Pool efímero de Cognito en Floci.

### Contrato
- Cada servicio publica `openapi.yaml` en `packages/contracts`.
- **Lado proveedor:** las respuestas reales de los handlers, incluidos los errores `problem+json`, validan contra el esquema.
- **Lado consumidor:** los *fixtures* y *stubs* que usan las pruebas del orquestador y del GraphQL API validan contra el **mismo** esquema. Si alguien cambia un contrato sin actualizar al consumidor, el build falla.
- **Esquema GraphQL:** el SDL generado se compara con el SDL versionado; un cambio incompatible requiere actualizarlo de forma explícita.
- No se usa Pact: añadiría un *broker* y binarios nativos sin aportar más que la validación compartida para un único equipo (regla 10).

### E2E
1. **SAGA exitosa:** la UI muestra `COMPLETED`, el conector pasa a `RESERVED` y el saldo baja.
2. **Fondos insuficientes:** `COMPENSATED`, el conector vuelve a `AVAILABLE` y el saldo no cambia.
3. **Falla de hardware** con la flag activada: `COMPENSATED`, con el reembolso visible en el historial.
4. **Doble envío** con la misma `idempotencyKey`: una sola SAGA.
5. **Flag en caliente:** activar *surge* cambia el precio mostrado sin reiniciar nada.
6. **Autorización:** un operador de otra flota recibe `FORBIDDEN`.

### Infraestructura
- `terraform fmt -check`, `validate` y `plan` por workspace.
- **`terraform test`** con aserciones sobre el plan: nombres con sufijo del workspace, versioning del bucket, `deletion_protection` en `prod`, endpoints VPCE presentes y precondición de workspace válido.
- `scripts/floci/smoke-test.sh` como prueba del entorno.
