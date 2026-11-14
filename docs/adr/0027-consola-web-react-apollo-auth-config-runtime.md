# ADR-0027: Consola web con React 19, Apollo Client 4, login con Cognito, configuración en tiempo de ejecución y polling

- **Estado:** Aceptado
- **Fecha:** 2026-11-13
- **Complementa:** [ADR-0017](0017-frontend-spa-mismo-origen-polling.md) (SPA en el mismo origen y polling), [ADR-0026](0026-graphql-api-apollo-bff-autenticacion-resiliencia.md) (BFF) y [ADR-0008](0008-autenticacion-cognito-autorizacion-por-grupos.md) (Cognito)

## Contexto

La especificación (§2.1) pide una consola B2B con estas vistas:

- estado de estaciones y conectores;
- reserva y activación de carga con el progreso de la SAGA;
- transacciones y compensaciones;
- feature flags por ambiente;
- observabilidad.

La consola consume **solo** el endpoint GraphQL. Hay cuatro restricciones:

1. el ambiente lo fija el despliegue, no el navegador;
2. el estado lo decide el backend;
3. no se afirma que haya tiempo real por WSS;
4. no hay secretos en el bundle.

ADR-0017 fijó el enfoque (SPA en el mismo origen, `config.json`, polling) y dejó las versiones y librerías para la implementación.

## Decisión

### Librerías (versiones exactas, publicadas hace más de 14 días)

| Uso | Paquete | Versión |
| --- | --- | --- |
| UI | `react` / `react-dom` | 19.3.1 |
| Bundler | `vite` + `@vitejs/plugin-react` | 8.3.8 / 6.3.0 |
| Cliente GraphQL | `@apollo/client` (+ `graphql`, `rxjs`) | 4.3.5 (16.14.2, 7.8.2) |
| Rutas | `react-router` (`HashRouter`) | 8.5.0 |
| Validación de formularios | `zod` (catálogo del monorepo) | 4.x |
| Pruebas de componentes | `@testing-library/react`, `user-event`, `jest-dom`, `jsdom` | 16.3.3, 14.6.7, 7.0.1, 30.1.3 |
| E2E en navegador | `playwright-core` (Chromium headless) | 1.62.1 |

No hay librería de componentes ni de estado global. Los componentes propios (`shared/ui`) cubren tablas, formularios, diálogos, interruptores y estados. La caché de Apollo es el único estado de datos.

### Arquitectura del frontend

```
src/
  app/          App (providers + rutas), AppShell (cabecera, navegación), EnvironmentIndicator
  features/<f>/ api.ts (documentos GraphQL tipados + hooks de datos)
                model.ts (tipos y transformaciones puras para presentar)
                use*.ts (hooks de interfaz: formularios, edición, seguimiento)
                *Page.tsx / components.tsx (solo presentación)
  shared/       api (Apollo, errores, viewer), auth, config, hooks, format, ui
```

- **Separación UI / hooks / servicios / modelos.**
  - Las páginas no llaman a Apollo directamente: usan hooks de `api.ts`.
  - La lógica de la interfaz vive en hooks: validar el formulario, mantener la clave de idempotencia por intento, confirmar el cambio de una flag y seguir la SAGA.
  - Las transformaciones puras están en `model.ts` y tienen pruebas unitarias.
- **Sin reglas de negocio en el cliente.**
  - El monto estimado, el saldo suficiente, el recargo, los conectores disponibles y el resultado de la SAGA vienen del backend.
  - Para eso se añadieron al BFF las consultas `chargingEstimate`, `viewer`, `sagas` y `systemStatus`, en lugar de calcularlas en el navegador.
  - El cliente solo valida el formato: ids requeridos, energía entre 0 y 500 kWh con 3 decimales y formato `fleet_…` para los administradores.
- **Documentos tipados.** Cada consulta es un `TypedDocumentNode<Data, Variables>`. Las consultas condicionales usan `skipToken`, como recomienda Apollo 4, que depreca los genéricos manuales y la opción `skip`.

### Autenticación

- **Login con usuario y contraseña de Cognito** (`InitiateAuth` con `USER_PASSWORD_AUTH`), contra un app client **público, sin secreto**.
  - La petición va a la ruta del mismo origen `./auth/cognito`, que el despliegue reenvía al endpoint de Cognito. En desarrollo la reenvía el proxy de Vite; en el E2E, el servidor de prueba.
  - Se verificó contra Floci: el login con credenciales válidas devuelve `IdToken`, y con una contraseña incorrecta devuelve `NotAuthorizedException`.
- **Sesión.**
  - El ID token se guarda en `sessionStorage` con su vencimiento y se descarta al vencer. Nunca se guarda la contraseña.
  - Cada operación GraphQL envía `Authorization: Bearer` y un `x-correlation-id` nuevo.
  - Si el backend responde `UNAUTHENTICATED`, se cierra la sesión.
- **Autorización.**
  - La decide el BFF. La UI solo adapta la vista según `viewer.isAdmin`: los operadores ven las flags en modo lectura y su flota fija; los administradores indican la flota.
  - Un operador que manipule la UI sigue recibiendo `FORBIDDEN` del backend.
- **Cliente Apollo por sesión.** El cliente (y su caché) se recrea al cambiar el token, para que no se muestren datos del usuario anterior.

### Ambiente

- `config.json` se lee en tiempo de ejecución, lo sirve el despliegue y lo valida un esquema Zod. Contiene:
  - `environment`;
  - `graphqlUrl`;
  - `auth {cognitoUrl, clientId}`;
  - `pollingIntervalMs` (1–60 s);
  - `cities`.
- La **misma imagen** se promueve entre ambientes.
- El badge muestra el ambiente que **informa el backend** (`viewer.environment`, el `APP_ENV` del graphql-api). Si no coincide con `config.json`, se muestra una alerta de configuración inconsistente.
- **No existe selector de ambiente.** Las URLs son relativas al mismo origen, así que el navegador no puede apuntar a otro ambiente. Aunque alguien edite el estado local, el backend al que llega sigue siendo el de su despliegue, y el token de otro User Pool se rechaza.

### "Tiempo real"

- Usa **polling configurable** (`pollingIntervalMs`) con `pollInterval` de Apollo en:
  - disponibilidad de estaciones y conectores;
  - sesiones activas y telemetría;
  - flags;
  - transacciones;
  - SAGAs.
- El polling se omite con la pestaña oculta (`skipPollAttempt`).
- El seguimiento de una SAGA deja de consultar al llegar a un estado terminal.
- **No hay suscripciones ni WSS.** La UI no afirma tener datos en tiempo real.

### Navegación y entrega

- `HashRouter`: el SPA se sirve como estáticos detrás de un prefijo variable (stage de API Gateway) sin reglas de reescritura.
- Las secciones se cargan bajo demanda (`React.lazy`): el bundle inicial baja de unos 594 kB a unos 465 kB (143 kB gzip) y Vite deja de advertir por chunks de más de 500 kB.

### Accesibilidad

- Enlace "Saltar al contenido", landmarks (`header`, `nav`, `main`) y tablas con `caption` y `scope`.
- Etiquetas asociadas a cada campo, con `aria-describedby` para la ayuda y el error, y `aria-invalid`.
- `role=switch` con `aria-checked`, y diálogo con `aria-modal`, foco inicial en Cancelar y cierre con Escape.
- Estados `role=status` y `role=alert`. El estado nunca se comunica solo por color: siempre hay texto.
- Foco visible, tema claro y oscuro, y respeto de `prefers-reduced-motion`.
- Layout responsive: la navegación lateral pasa a barra horizontal por debajo de 900 px.

## Alternativas

1. **Cognito Hosted UI u OAuth con PKCE.**
   - Es lo recomendado en AWS real: no se manejan contraseñas en la app y admite MFA y federación.
   - La Hosted UI y el flujo de autorización no se han verificado en Floci, y el objetivo es una demo reproducible en local.
   - Queda como mejora para AWS real; el cambio está acotado a `shared/auth`.
2. **Amplify.** Añade una dependencia grande para un solo `InitiateAuth`.
3. **Variables `VITE_*` en build.** Fijan el ambiente en el bundle e impiden promover la misma imagen. ADR-0017 ya las descartó.
4. **Suscripciones GraphQL o WSS.** Siguen fuera de alcance (ADR-0017): no pasan por API Gateway REST.
5. **`BrowserRouter`.** Necesita *fallback* a `index.html` en el servidor para cada ruta. `HashRouter` funciona igual en Vite, nginx y la ruta `/{proxy+}`.
6. **Librería de componentes (MUI u otra).** Más peso y estilos que adaptar. Unos pocos componentes propios bastan y son fáciles de defender.

## Consecuencias

- **Positivas:**
  - Consola demostrable sin Postman.
  - El E2E en navegador real usa Cognito, el BFF, los cuatro servicios y DynamoDB de Floci.
  - El ambiente es inequívoco y el bundle no contiene secretos (lo comprueba `grep` sobre `dist/`).
- **Negativas:**
  - El ID token en `sessionStorage` es accesible a un XSS. Se mitiga así:
    - no se inyecta HTML;
    - no se cargan scripts de terceros en tiempo de ejecución;
    - la CSP de nginx queda pendiente para la fase de contenedores.
  - No hay *refresh token*: al vencer el ID token (1 h) hay que volver a iniciar sesión.
  - El polling genera carga constante, mitigada con un intervalo configurable y la pausa con la pestaña oculta.
  - La búsqueda por `correlation_id` en Observabilidad es local, sobre la página cargada (50 SAGAs). Una búsqueda global requiere un índice en el orquestador.
