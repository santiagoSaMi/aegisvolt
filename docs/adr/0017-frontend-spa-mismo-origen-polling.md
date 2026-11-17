# ADR-0017: Frontend SPA (React + TypeScript) servido en el clúster detrás del mismo API Gateway, con polling

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.1 deja libre el framework y exige cuatro vistas, entre ellas el estado "en tiempo real". El diagrama menciona HTTPS/WSS. API Gateway REST no proxea WebSocket hacia un backend GraphQL (P-04, pendiente de re-verificar en la documentación oficial). Cada ambiente debe tener su frontend conectado a su propio GraphQL.

## Decisión

- **SPA en React + TypeScript** (Vite como *bundler*; versiones exactas en un ADR al implementar). Se elige por su ecosistema maduro para GraphQL y por la experiencia previa disponible.
- **Despliegue:** imagen nginx no root con los estáticos, desplegada en cada clúster como un Rollout más y expuesta por el NLB (listener 8080) y la ruta `/{proxy+}` de la **misma API REST** que `/graphql`.
  - Un solo origen: sin CORS.
  - El *base path* es relativo para soportar el prefijo del stage.
- **"Tiempo real" por polling** cada 2–5 s de queries GraphQL (estaciones, SAGA en curso, flags). WSS queda fuera de alcance y documentado.
- **Configuración de ambiente** en tiempo de ejecución (`config.json` del overlay): nombre del ambiente, User Pool y cliente de Cognito.

## Alternativas

1. **S3 + CloudFront.** Es lo ideal en AWS real. En Floci, CloudFront y el *website hosting* no se han verificado, y añaden otro camino de despliegue distinto del canary en K8s.
2. **Suscripciones GraphQL por WebSocket.** No pasan por API Gateway REST; requerirían exponer otro endpoint fuera de la arquitectura.
3. **Next.js con SSR.** Añade un servidor Node y una complejidad innecesaria para una consola interna.

## Consecuencias

- **Positivas:** un solo mecanismo de despliegue (K8s y canary) para todo, sin CORS y con una configuración por ambiente simple.
- **Negativas:**
  - Las peticiones de estáticos pasan por API Gateway (coste y latencia en AWS real).
  - El polling genera carga constante, mitigada con intervalos moderados.
  - "Tiempo real" significa casi tiempo real (segundos).
