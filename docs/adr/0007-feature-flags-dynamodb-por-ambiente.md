# ADR-0007: Feature flags propias en DynamoDB, una tabla por ambiente, con caché corta

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

§2.2 exige feature flags con estado independiente por ambiente y propone DynamoDB propio, Unleash, Flagsmith o AppConfig. §6.4 exige cambiar una flag en `dev` sin redesplegar y que `prod` no se vea afectado. Las flags se evalúan en servicios distintos.

## Decisión

- Una tabla `aegisvolt-feature-flags-<env>` por ambiente, creada por Terraform.
- **Valores iniciales** sembrados con `aws_dynamodb_table_item` desde `envs/<env>.tfvars`, con `lifecycle { ignore_changes = [item] }` para que `apply` no revierta los cambios en caliente (P-13).
- **Escritura:** solo la mutación `setFeatureFlag` (rol `platform-admins`) en el módulo `flags` del GraphQL API, con `version` condicional y un `FlagAudit` en la misma transacción. Alternativa para la demo: `scripts/flags/set.sh`.
- **Lectura:** el paquete compartido `packages/feature-flags` expone el puerto `FeatureFlagReader` y un adaptador DynamoDB con caché de 5 s. Si falla la lectura, usa el último valor conocido o el valor seguro `false`.
- Es una **excepción de solo lectura** a Database-per-Service: las flags son configuración de plataforma, no datos de negocio de otro contexto.

## Alternativas

1. **AWS AppConfig.** Servicio gestionado por ambiente con perfil de feature flags. Floci lo emula (`appconfig`, `appconfigdata`), pero sus *deployments* y *strategies* no se han verificado. Es una buena evolución.
2. **Unleash o Flagsmith.** Requieren desplegar y operar otro servidor con su base de datos (por ambiente o con proyectos). Es una dependencia pesada para tres flags booleanas (regla 10).
3. **Variables de entorno o ConfigMap.** Cambiarlas exige reiniciar o redesplegar, lo que incumple §6.4.
4. **Servicio HTTP de flags.** Añade un salto de red y un punto de fallo a cada evaluación.

## Consecuencias

- **Positivas:**
  - Aislamiento físico por ambiente.
  - Cambios en ≤ 5 s sin redesplegar.
  - Auditoría y demo simple con `aws dynamodb get-item`.
- **Negativas:**
  - La tabla la leen varios servicios; se mitiga con IAM de solo lectura y un único escritor.
  - La caché introduce hasta 5 s de inconsistencia entre réplicas, lo que es aceptable para flags.
