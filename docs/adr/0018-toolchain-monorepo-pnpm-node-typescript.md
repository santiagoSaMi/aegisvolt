# ADR-0018: Toolchain del monorepo (pnpm 12, Node.js 26 LTS, TypeScript 6.0, ESLint, Prettier, Vitest, dependency-cruiser)

- **Estado:** Aceptado
- **Fecha:** 2026-11-12

## Contexto

CLAUDE.md exige:
- TypeScript `strict`;
- separar en capas (arquitectura hexagonal);
- lint, typecheck, pruebas y build;
- versiones verificadas, no supuestas.

Cada microservicio debe poder desplegarse de forma independiente, y la fase pide pnpm workspaces, ESLint, Prettier, EditorConfig y detección de ciclos y límites de capas.

Versiones verificadas el 2026-11-12 en nodejs.org y el registro de npm:
- **Node.js:** v26.13.1 es la línea *Active LTS* (Lithium); v24 está en *Maintenance LTS*.
- **TypeScript:** `latest` es 7.0.2, el compilador nativo. typescript-eslint 8.72.2 declara `typescript >=4.8.4 <6.1.0`.
- **pnpm:** 12.18.0. Aplica por defecto una edad mínima de publicación para mitigar ataques de cadena de suministro.

## Decisión

| Herramienta | Versión | Notas |
| --- | --- | --- |
| Node.js | 26.x (`.nvmrc`, `engines`, `engineStrict`) | Ejecuta TypeScript nativamente (type stripping) en desarrollo |
| pnpm | 12.18.0 (`packageManager`) | Workspaces `apps/*`, `services/*`, `packages/*` y **catalog** como fuente única de versiones compartidas |
| TypeScript | **6.0.3** | No 7.x: typescript-eslint aún no la soporta |
| ESLint | 10.14.0, flat config | `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` con `projectService`; plugins React solo en `apps/web`; `eslint-config-prettier` |
| Prettier | 3.9.10 | 3.10.x era más reciente que la edad mínima de pnpm; no se añadió excepción a la política |
| Vitest | 5.1.0 | Pruebas en todos los paquetes |
| dependency-cruiser | 18.7.2 | Ciclos, límites entre unidades desplegables, capas hexagonales, devDependencies en producción, dependencias no declaradas |
| Vite + React | 8.3.8 / 19.3.1 | Solo `apps/web` (ADR-0017) |

Convenciones de compilación:
- **ESM** (`"type": "module"`) con `module`/`moduleResolution: NodeNext`.
- **Importaciones relativas con extensión `.ts`**, con `allowImportingTsExtensions` y `rewriteRelativeImportExtensions`: `tsc` las reescribe a `.js` al compilar, y Node 26 puede ejecutar `src/main.ts` directamente en desarrollo, sin `tsx` ni `ts-node`.
- **`erasableSyntaxOnly`:** sin `enum`, `namespace` ni *parameter properties*, para que Node pueda ejecutar el código solo eliminando tipos.
- **Opciones estrictas además de `strict`:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns` y `verbatimModuleSyntax`.
- **Paquetes transversales** compilados a `dist/` con declaraciones. Las apps los consumen como `workspace:*`. Los scripts raíz `lint`, `typecheck` y `test` compilan primero los paquetes.
- **Despliegue independiente:**
  - cada unidad declara sus dependencias de producción y publica solo `dist` (`files`);
  - `pnpm --filter <app> deploy --prod <dir>` genera un paquete aislado sin devDependencies (verificado en las cinco unidades Node);
  - las versiones de herramientas por paquete (`typescript`, `vitest`, `@types/node`) usan `catalog:`.

## Alternativas

1. **npm o Yarn workspaces.** npm no tiene `deploy` aislado ni catálogos. Yarn PnP complica la compatibilidad de herramientas.
2. **TypeScript 7 (nativo).** Es más rápido, pero rompe el lint con tipos (typescript-eslint).
3. **Node 24 LTS.** Es válido, pero está en mantenimiento. Node 26 es la Active LTS y todas las herramientas la soportan.
4. **`tsx`/`ts-node` para desarrollo.** Son dependencias innecesarias con Node 26 (regla 10).
5. **Turborepo/Nx.** Caché y orquestación de tareas son útiles en repos grandes; aquí bastan `pnpm -r` (orden topológico) y los filtros.
6. **eslint-plugin-boundaries o import-x para capas.** dependency-cruiser cubre ciclos y capas en una sola herramienta y con reglas declarativas legibles. Sus reglas se verificaron con violaciones deliberadas.

## Consecuencias

- **Positivas:** un solo `pnpm check` valida formato, lint, límites, tipos, pruebas y build; las reglas de arquitectura se aplican automáticamente.
- **Negativas:**
  - Hace falta Node 26 en local (nvm) y en CI.
  - Los paquetes transversales deben compilarse antes de typecheck y lint de los consumidores.
  - Cuando typescript-eslint soporte TypeScript 7, convendrá reevaluar esta decisión.
