# ADR-0008: Autenticación con Amazon Cognito (JWT) y autorización por grupos y flota

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

Hay operadores de flota y administradores, y las mutaciones administrativas (`setFeatureFlag`, `topUpWallet`) deben estar protegidas. Cada operador solo puede operar sobre su flota. Además, un token de un ambiente no debe valer en otro.

## Decisión

- Un **User Pool de Cognito por ambiente** (Terraform), con los grupos `fleet-operators` y `platform-admins` y el atributo `custom:fleet_id`.
- El **GraphQL API siempre verifica el JWT**: firma contra JWKS, `iss`, `aud`, `exp` y `token_use`. Se implementa detrás del puerto `TokenVerifier`.
- **Autorización en una capa de políticas** y no en los resolvers: el alcance por flota y el rol de administrador.
- **En AWS real**, además, un *Cognito authorizer* en API Gateway (defensa en profundidad).
- **Entre servicios:** solo `ClusterIP` + NetworkPolicies, sin mTLS.

Verificado en Floci 2.4.0:
- `initiate-auth` con `USER_PASSWORD_AUTH` emite un RS256 con `cognito:groups` y `custom:fleet_id`.
- El JWKS se publica en `/<poolId>/.well-known/jwks.json`.
- El `iss` es `http://floci:4566/<poolId>`.

## Alternativas

1. **Solo el *authorizer* de API Gateway.** No se verificó que Floci lo aplique, y el clúster quedaría sin defensa si alguien accede al NLB directamente.
2. **API keys de API Gateway.** No identifican usuarios ni roles.
3. **JWT emitidos por el propio backend.** Hay que gestionar contraseñas y rotación de claves, y se aleja de AWS.
4. **mTLS o service mesh entre servicios.** Fuera del alcance de la especificación (regla 10).

## Consecuencias

- **Positivas:** identidad gestionada, verificable en Floci y separada por ambiente; las reglas de autorización se pueden probar unitariamente.
- **Negativas:**
  - Se depende de que Floci mantenga su emulación de Cognito (R-01).
  - Los pods necesitan resolver `floci` ([ADR-0012](0012-eks-cluster-por-ambiente-kustomize-acceso-floci.md)).
  - Dentro del clúster no hay identidad de servicio criptográfica.
