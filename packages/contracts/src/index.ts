// Contratos públicos de integración entre unidades desplegables.
// Solo forma de mensajes (DTOs, cabeceras, errores); nunca entidades ni reglas de negocio.
// Documentación y política de versiones: docs/contracts/README.md

export { HTTP_HEADERS, type HttpHeaderName } from './http-headers.ts';
export {
  COMMON_ERROR_CODES,
  PROBLEM_JSON_CONTENT_TYPE,
  errorCodeSchema,
  isProblemDetails,
  problemDetailsSchema,
  problemSchemaFor,
  type ProblemDetails,
} from './problem-details.ts';
export * from './common/identifiers.ts';
export * from './common/primitives.ts';
export * from './common/headers.ts';

export * as stationReservationV1 from './station-reservation/v1.ts';
export * as billingWalletV1 from './billing-wallet/v1.ts';
export * as energyDispatchV1 from './energy-dispatch/v1.ts';
export * as sagaOrchestratorV1 from './saga-orchestrator/v1.ts';
export * as featureFlagsV1 from './feature-flags/v1.ts';
