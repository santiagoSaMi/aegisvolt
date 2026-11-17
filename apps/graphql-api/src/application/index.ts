// Capa de aplicación del graphql-api (módulo de flags, ADR-0007/0025).
// Depende del dominio y del catálogo genérico de @aegisvolt/feature-flags.
export * from './errors.ts';
export * from './authorization.ts';
export * from './optimistic-retry.ts';
export * from './flag-snapshot-cache.ts';
export * from './ports/feature-flags.ts';
export * from './use-cases/feature-flags.ts';
export * from './ports/upstreams.ts';
export * from './use-cases/queries.ts';
export * from './use-cases/commands.ts';
export * from './ports/auth.ts';
