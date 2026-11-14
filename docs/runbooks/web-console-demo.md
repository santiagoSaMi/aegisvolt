# Runbook: demostración de la consola web contra Floci

Muestra el flujo completo **desde el navegador**, sin Postman: login con Cognito, carga exitosa, falla inducida por flag y compensación visible. Usa solo credenciales ficticias del emulador.

## Opción A: automática (recomendada para la sustentación)

```bash
scripts/floci/start.sh
REQUIRE_INTEGRATION=true pnpm test:e2e
```

`tests/e2e/test/web.e2e.test.ts` hace lo siguiente:

1. compila la consola;
2. levanta los cuatro servicios y el graphql-api con tablas temporales;
3. crea un User Pool de prueba;
4. sirve la SPA en `http://127.0.0.1:24105` con un `config.json` del ambiente `local`;
5. la recorre en Chromium headless.

Capturas en `tests/e2e/.evidence/web/`:

| Archivo | Qué muestra |
| --- | --- |
| `01-carga-completada.png` | Operador: SAGA `COMPLETED` con todos los pasos y su `correlation_id` |
| `02-transacciones.png` | El débito en el historial |
| `03-flag-activada.png` | Administrador: `SIMULATE_CHARGER_HARDWARE_FAULT` activada, con el `correlation_id` de la auditoría |
| `04-carga-compensada.png` | Operador: SAGA `COMPENSATED` (reembolso y liberación del conector) |
| `05-observabilidad.png` | Historial de eventos de la SAGA compensada |

## Opción B: manual con `pnpm dev`

1. Preparar Floci, las tablas, los servicios y el User Pool con un operador (`operador1`, flota `fleet_demo`) como indica la [guía GraphQL §1](../graphql/README.md#1-ejecutar-en-local-contra-floci). Añadir un administrador:

   ```bash
   aws cognito-idp admin-create-user --user-pool-id $POOL --username admin1 --message-action SUPPRESS
   aws cognito-idp admin-set-user-password --user-pool-id $POOL --username admin1 --password 'Local-Passw0rd!' --permanent
   aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username admin1 --group-name platform-admins
   ```

2. Configurar la consola y arrancarla:

   ```bash
   cp apps/web/.env.example apps/web/.env
   sed -i "s/^DEV_COGNITO_CLIENT_ID=.*/DEV_COGNITO_CLIENT_ID=$CLIENT/" apps/web/.env
   pnpm --filter @aegisvolt/web dev        # http://localhost:5173
   ```

3. Recorrido:
   1. Entrar como `operador1`. El badge **Ambiente: LOCAL** viene del backend.
   2. **Carga**: elegir estación, conector y kWh, revisar el monto estimado e **Iniciar carga**. El progreso se actualiza por polling hasta **Completada**.
   3. Cerrar sesión y entrar como `admin1`. En **Feature flags**, activar `SIMULATE_CHARGER_HARDWARE_FAULT` y confirmar.
   4. Volver como `operador1` e iniciar otra carga. El resultado es **Compensada**: falla del cargador, reembolso y liberación.
   5. En **Observabilidad** se ven los eventos, el `correlation_id` y el plan de compensación. Ese `correlation_id` sirve para filtrar los logs de los servicios.
   6. En **Transacciones** aparecen el débito y el reembolso, y la operación figura en "Errores y compensaciones".
