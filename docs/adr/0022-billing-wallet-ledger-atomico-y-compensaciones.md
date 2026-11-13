# ADR-0022: billing-wallet — libro mayor atómico, idempotencia y reembolso como operación propia

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Relación:** implementa ADR-0005, ADR-0006 y ADR-0020 en billing-wallet-service, con el mismo estilo que [ADR-0021](0021-station-reservation-concurrencia-idempotencia-expiracion.md).

## Contexto

El servicio administra el dinero de las flotas y debe garantizar:
1. saldo nunca negativo;
2. cada movimiento auditable;
3. un débito repetido con la misma clave no descuenta dos veces;
4. un reembolso repetido no reembolsa dos veces;
5. saldo y movimiento actualizados de forma atómica;
6. la compensación como operación de negocio independiente y trazable;
7. registro de `saga_id`, `correlation_id`, `operation_id` e idempotency key;
8. enteros, nunca coma flotante;
9. concurrencia resuelta con condiciones explícitas;
10. que el cliente no fije saldos ni resultados.

## Decisión

### Modelo
- Una tabla *single-table* (`aegisvolt-billing-<env>`):
  - billetera y libro mayor en la misma partición (`WALLET#<fleet>`, movimientos con `SK = TX#<instante>#<id>`);
  - débitos, reembolsos y recargas con su propia clave;
  - GSI1 por SAGA para la auditoría.
- Sin TTL en registros financieros.
- **Reembolso = entidad `Refund`** (`rfd_<valor del débito>`): una por débito, con motivo, importe, auditoría y su propio movimiento `REFUND`. El débito pasa a `REFUNDED` con `refundId`.
- **Movimiento con id derivado de la operación** (`wtx_debit-…`, `wtx_refund-…`, `wtx_topup-…`): cada operación produce exactamente un movimiento.
- **`OperationAudit`** (`correlationId` + clave idempotente) en débitos, reembolsos, recargas, tombstones y movimientos.
  - Débito: la clave es el `debitId` (`PUT`) o la `idempotency-key` (`POST` → `dbt_<clave>`).
  - Reembolso: la clave enviada o, por defecto, el `refundId`.
  - Recarga: el `topUpId`.

### Transacciones condicionales (`TransactWriteItems`)

| Operación | Escrituras (todo o nada) | Condiciones |
| --- | --- | --- |
| Débito aplicado | saldo · Debit · movimiento DEBIT | billetera en la versión leída, misma moneda y **`balanceMinor >= :importe`**; Debit y movimiento nuevos (`attribute_not_exists`) |
| Débito rechazado | Debit `REJECTED_INSUFFICIENT_FUNDS` | id nuevo; no hay movimiento porque no movió dinero |
| Reembolso | Debit → `REFUNDED` · Refund · saldo · movimiento REFUND | **Debit `status = DEBITED`** y versión leída; Refund nuevo; billetera en la versión leída |
| Recarga | saldo · TopUp · movimiento TOP_UP | billetera en la versión leída; TopUp nuevo |
| Anulación (refund sin débito) | tombstone | id nuevo |

- **Concurrencia:** ante una condición fallida (`ConcurrentModificationError`), el caso de uso relee y decide de nuevo, hasta 3 intentos y luego `503`. Dos débitos sobre la misma billetera se serializan por la versión; el segundo puede acabar en fondos insuficientes (`422`).
- **Cliente sin poder sobre el dinero:**
  - el importe del débito lo calcula `PricingPolicy` (tarifa × Wh × surge, con `BigInt`);
  - la billetera se abre con saldo 0 en la moneda configurada;
  - las peticiones son `z.strictObject`, así que un `amount` o `balance` en el cuerpo → `400`.
- **Validación de la compensación:** solo la SAGA dueña del débito puede reembolsarlo (`409 DEBIT_MISMATCH`, error de dominio nuevo).
- **Infraestructura compartida en estilo, no en código:** el middleware HTTP, el cliente AWS, la readiness y el reintento optimista se copiaron de station-reservation. Así cada servicio sigue siendo desplegable e independiente. Si un tercer servicio los necesita, se evaluará extraerlos a un paquete.

### Capa de presentación unificada
- La capa de entrada de **todas** las unidades se llama `presentation`, y así quedó en CLAUDE.md y en las reglas de dependency-cruiser. Antes se llamaba `interfaces`.

## Alternativas

1. **Actualizar el saldo con `ADD balanceMinor :delta` sin versión.** Atómico por ítem, pero no impide perder la coherencia con el `balanceAfter` del movimiento ni sirve para el reembolso. La versión más la condición de fondos es explícita y verificable.
2. **Reembolso como simple cambio de estado del débito.** No cumple "operación de negocio independiente y trazable".
3. **Ids de movimiento aleatorios.** Necesitarían otra condición para garantizar un movimiento por operación; el id derivado lo garantiza con `attribute_not_exists`.
4. **Retener fondos en `funds-check`.** Añade estado y expiraciones. La especificación cobra directamente el importe estimado (P-08), y la verificación es una consulta.

## Consecuencias

- **Positivas:**
  - Invariantes financieras garantizadas por DynamoDB, demostradas contra Floci: 8 débitos simultáneos con saldo para 3 → 3 cobros y saldo exacto; 3 reembolsos simultáneos → 1 aplicado.
  - Historial auditable, consultable por flota y por SAGA.
- **Negativas:**
  - Código de infraestructura duplicado entre servicios (decisión consciente).
  - Las billeteras muy concurridas se serializan por versión, lo que puede generar `503` con mucha contención; es aceptable para flotas.
  - Hasta tener el lector de flags, `ENABLE_DYNAMIC_SURGE_PRICING` requiere reiniciar el servicio.
