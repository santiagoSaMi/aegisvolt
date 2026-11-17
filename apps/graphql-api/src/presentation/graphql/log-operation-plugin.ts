import type { ApolloServerPlugin, BaseContext } from '@apollo/server';
import { setLogOperation, type Logger } from '@aegisvolt/logger';
import { Kind, type OperationDefinitionNode } from 'graphql';

const MAX_LENGTH = 64;

/**
 * Nombre de la operación para los logs: `<tipo>.<nombre>` (p. ej.
 * `mutation.ReserveAndActivateCharging`). Si la operación es anónima se usa el
 * primer campo raíz (`query.stations`). El nombre lo envía el cliente: ya es un
 * Name válido de GraphQL (Apollo lo parseó) y se acota en longitud.
 */
export function operationLabel(
  operation: OperationDefinitionNode,
  operationName: string | null,
): string {
  const root = operation.selectionSet.selections.find((s) => s.kind === Kind.FIELD);
  const name = operationName ?? (root?.kind === Kind.FIELD ? root.name.value : 'anonymous');
  return `${operation.operation}.${name}`.slice(0, MAX_LENGTH);
}

/** Códigos que indican un fallo del servidor (no del cliente): cuentan para la tasa de error. */
const SERVER_ERROR_CODES = new Set(['SERVICE_UNAVAILABLE', 'INTERNAL_SERVER_ERROR']);

export type OperationOutcome = 'ok' | 'client_error' | 'server_error';

/** Resultado de una operación a partir de los códigos de sus errores (ya formateados). */
export function operationOutcome(codes: readonly string[]): OperationOutcome {
  if (codes.some((code) => SERVER_ERROR_CODES.has(code))) {
    return 'server_error';
  }
  return codes.length > 0 ? 'client_error' : 'ok';
}

/**
 * - Fija `operation` en el contexto de logs en cuanto Apollo resuelve la operación:
 *   los logs de resolvers, de las llamadas a servicios y `http_request` la incluyen.
 * - Al responder, registra una línea `graphql_operation` con el resultado. GraphQL
 *   responde HTTP 200 aunque falle un servicio interno, así que la tasa de error del
 *   BFF se mide con estas líneas (métricas GraphqlOperations/GraphqlServerErrors por
 *   versión, usadas por el análisis canary, ADR-0032).
 */
export function logOperationPlugin<TContext extends BaseContext>(
  logger: Logger,
): ApolloServerPlugin<TContext> {
  return {
    requestDidStart() {
      return Promise.resolve({
        didResolveOperation({ operation, operationName }) {
          if (operation !== undefined) {
            setLogOperation(operationLabel(operation, operationName ?? null));
          }
          return Promise.resolve();
        },
        willSendResponse({ response }) {
          const body = response.body;
          const errors = body.kind === 'single' ? (body.singleResult.errors ?? []) : [];
          const codes = errors.map((error) => {
            const code = error.extensions?.code;
            return typeof code === 'string' ? code : 'UNKNOWN';
          });
          const outcome = operationOutcome(codes);
          const fields = {
            event: 'graphql_operation',
            outcome,
            ...(codes.length === 0 ? {} : { error_codes: [...new Set(codes)] }),
          };
          if (outcome === 'server_error') {
            logger.error('Operación GraphQL fallida', fields);
          } else {
            logger.info('Operación GraphQL', fields);
          }
          return Promise.resolve();
        },
      });
    },
  };
}
