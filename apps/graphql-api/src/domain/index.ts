// Dominio del GraphQL API: solo el contexto genérico Platform Configuration
// (feature flags, ADR-0007). El resto del BFF compone lecturas sin reglas de negocio.
export * from './shared/domain-error.ts';
export * from './feature-flags/feature-flag.ts';
