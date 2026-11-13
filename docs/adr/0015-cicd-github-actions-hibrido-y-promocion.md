# ADR-0015: CI/CD con GitHub Actions híbrido (hospedado + self-hosted), rulesets y promoción lineal con merge commit

- **Estado:** Propuesto. Pendiente de confirmar la visibilidad del repositorio (P-21) y el destino de `main` (P-22).
- **Fecha:** 2026-11-12

## Contexto

§3 exige:
- ramas `dev`, `test` y `prod` protegidas: sin force push, sin push directo, checks obligatorios;
- promoción lineal por PR;
- checks pre-merge: lint/build, unit, integration, e2e y `terraform plan` del workspace destino;
- apply post-merge según la rama destino;
- canary.

Datos verificados en la documentación de GitHub:
- en GitHub Free, la protección de ramas y los *environments* solo están disponibles para repos **públicos**;
- los self-hosted runners "should almost never be used for public repositories";
- `github.base_ref` contiene la rama destino de un PR.

Los ambientes viven en un Floci local persistente.

## Decisión

- **Rulesets en `dev`, `test` y `prod`:**
  - Block force pushes y Restrict deletions;
  - PR obligatorio con 0 aprobaciones (proyecto individual, P-23);
  - checks obligatorios (`promotion-guard`, `lint-build`, `unit-tests`, `integration-tests`, `e2e-tests`, `terraform-plan`);
  - sin bypass.
- **`promotion-guard`** valida el par origen→destino, porque no existe una regla nativa para la rama origen (P-30).
- **Merge commit** en `dev→test` y `test→prod`; *squash* solo en `feature→dev` (P-24).
- **Runners hospedados** (Floci efímero en memoria): guard, lint/build, unit, integration y e2e.
- **Runner self-hosted** (label `aegisvolt-floci`, efímero) en el equipo con Floci: `terraform-plan` y, en `push`, apply, imagen, canary y smoke.
- **`TARGET_ENV`** = `github.base_ref` en PR y `github.ref_name` en push, validado contra `dev|test|prod`.
- **`concurrency`** por ambiente.
- **Imágenes:** se construyen una vez en `dev` y se promueve el mismo digest a `test` y `prod`.
- **Visibilidad (recomendación):** repo **público**, con jobs self-hosted solo en `push` a ramas protegidas y en PRs del mismo repo, aprobación obligatoria para colaboradores externos y sin credenciales reales en el runner. Alternativa: repo privado con GitHub Pro.

## Alternativas

1. **Todo en runners hospedados con Floci efímero.** Seguro, pero los ambientes no persistirían, así que `terraform plan` contra el estado real y el canary en el ambiente no serían posibles.
2. **Todo self-hosted.** Más simple, pero ejecutaría código de PRs en el equipo local con mayor exposición.
3. **GitLab CI.** La especificación lo admite, pero se mantiene GitHub (CLAUDE.md).
4. **Squash en todas las promociones.** Provoca divergencias y conflictos entre ramas.

## Consecuencias

- **Positivas:** cumple todos los checks y el apply dinámico de §3.3 con ambientes persistentes demostrables.
- **Negativas:**
  - Riesgo de seguridad del self-hosted runner en un repo público (R-04), mitigado pero no eliminado.
  - El CD depende de que el equipo local esté encendido.
- **Requiere decisión del autor:** visibilidad del repositorio y plan de GitHub, y qué hacer con `main`.
