/**
 * Reglas de dependencias del monorepo (dependency-cruiser).
 *
 * - Sin dependencias circulares.
 * - Cada app/servicio es una unidad desplegable: no importa código de otra.
 * - Los paquetes transversales (packages/*) no dependen de apps ni servicios.
 * - Arquitectura hexagonal dentro de cada app/servicio:
 *     domain  <-  application  <-  presentation / infrastructure  <-  main.ts
 * - El código de producción no depende de devDependencies ni de módulos sin declarar.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Las dependencias circulares impiden razonar y probar los módulos por separado.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-cross-deployable-imports',
      severity: 'error',
      comment:
        'Una app o servicio no importa código de otra unidad desplegable. ' +
        'La comunicación es por HTTP con contratos (packages/contracts).',
      from: { path: '^(apps|services)/([^/]+)/' },
      to: { path: '^(apps|services)/', pathNot: '^$1/$2/' },
    },
    {
      name: 'packages-do-not-depend-on-deployables',
      severity: 'error',
      comment: 'Los paquetes transversales son genéricos y no conocen apps ni servicios.',
      from: { path: '^packages/' },
      to: { path: '^(apps|services)/' },
    },
    {
      name: 'domain-is-isolated',
      severity: 'error',
      comment:
        'El dominio no depende de application, infrastructure, presentation, main ni de los ' +
        'paquetes transversales (pnpm los resuelve como rutas locales packages/*).',
      from: { path: '^(apps|services)/[^/]+/src/domain/' },
      to: {
        path: '^(apps|services)/[^/]+/src/(application|infrastructure|presentation)/|/src/main\\.ts$|^packages/',
      },
    },
    {
      name: 'domain-has-no-external-dependencies',
      severity: 'error',
      comment: 'El dominio es TypeScript puro: sin SDK de AWS, frameworks, ni módulos de Node.',
      from: { path: '^(apps|services)/[^/]+/src/domain/' },
      to: { dependencyTypesNot: ['local', 'type-only'] },
    },
    {
      name: 'application-does-not-depend-on-adapters',
      severity: 'error',
      comment: 'Los casos de uso dependen de puertos, nunca de adaptadores concretos.',
      from: { path: '^(apps|services)/[^/]+/src/application/' },
      to: {
        path: '^(apps|services)/[^/]+/src/(infrastructure|presentation)/|/src/main\\.ts$',
      },
    },
    {
      name: 'adapters-do-not-depend-on-each-other',
      severity: 'error',
      comment: 'presentation (entrada) e infrastructure (salida) se conectan solo en main.ts.',
      // Tres grupos ($1 tipo, $2 unidad, $3 capa): dentro de la misma capa sí se importa.
      from: { path: '^(apps|services)/([^/]+)/src/(presentation|infrastructure)/' },
      to: {
        path: '^(apps|services)/[^/]+/src/(presentation|infrastructure)/',
        pathNot: '^$1/$2/src/$3/',
      },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Importación que no se puede resolver.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-dependencies',
      severity: 'error',
      comment: 'Toda dependencia npm debe estar declarada en el package.json del paquete.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'production-code-not-to-dev-dependencies',
      severity: 'error',
      comment:
        'El código de src/ no puede usar devDependencies (no estarán en la imagen de producción).',
      from: { path: '^(apps|services|packages)/[^/]+/src/', pathNot: '\\.(test|spec)\\.tsx?$' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    // node_modules y el build de los paquetes del workspace (destino de "@aegisvolt/*") se
    // registran como dependencias pero no se recorren. NO se excluyen: excluirlos ocultaría
    // esas dependencias y las reglas sobre ellas no se evaluarían.
    doNotFollow: { path: ['node_modules', '^packages/[^/]+/dist/'] },
    exclude: { path: '^(apps|services)/[^/]+/(dist|coverage)/|^packages/[^/]+/coverage/' },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
