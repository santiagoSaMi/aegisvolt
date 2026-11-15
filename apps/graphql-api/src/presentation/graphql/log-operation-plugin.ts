import type { ApolloServerPlugin, BaseContext } from '@apollo/server';
import { setLogOperation } from '@aegisvolt/logger';
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

/**
 * Fija `operation` en el contexto de logs de la petición en cuanto Apollo
 * resuelve la operación: los logs de resolvers, de las llamadas a servicios y la
 * línea `http_request` la incluyen.
 */
export function logOperationPlugin<TContext extends BaseContext>(): ApolloServerPlugin<TContext> {
  return {
    requestDidStart() {
      return Promise.resolve({
        didResolveOperation({ operation, operationName }) {
          if (operation !== undefined) {
            setLogOperation(operationLabel(operation, operationName ?? null));
          }
          return Promise.resolve();
        },
      });
    },
  };
}
