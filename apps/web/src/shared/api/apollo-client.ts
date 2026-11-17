import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from '@apollo/client';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { SetContextLink } from '@apollo/client/link/context';
import { ErrorLink } from '@apollo/client/link/error';

export interface ApolloClientOptions {
  /** Ruta del mismo origen (`./graphql`). El navegador no puede apuntar a otro ambiente. */
  readonly graphqlUrl: string;
  /** Token de la sesión actual (o ninguno). */
  readonly getToken: () => string | undefined;
  /** El backend rechazó la identidad (token vencido o inválido). */
  readonly onUnauthenticated: () => void;
  readonly fetch?: typeof fetch;
}

/**
 * Cliente GraphQL de la consola:
 * - `Authorization: Bearer <ID token>` en cada operación;
 * - `x-correlation-id` nuevo por operación (el backend lo devuelve en
 *   `extensions.correlationId` de los errores para rastrearlo en los logs);
 * - `UNAUTHENTICATED` → cierra la sesión.
 * Todo el estado viene del backend: la caché solo evita peticiones repetidas.
 */
export function createApolloClient(options: ApolloClientOptions) {
  const auth = new SetContextLink((previous) => {
    const token = options.getToken();
    return {
      headers: {
        ...(previous.headers as Record<string, string> | undefined),
        'x-correlation-id': crypto.randomUUID(),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    };
  });
  const errors = new ErrorLink(({ error }) => {
    if (
      CombinedGraphQLErrors.is(error) &&
      error.errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED')
    ) {
      options.onUnauthenticated();
    }
  });
  const http = new HttpLink({
    uri: options.graphqlUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return new ApolloClient({
    link: ApolloLink.from([errors, auth, http]),
    cache: new InMemoryCache({
      typePolicies: {
        Saga: { keyFields: ['sagaId'] },
        Station: { keyFields: ['stationId'] },
        ChargingSession: { keyFields: ['sessionId'] },
        Reservation: { keyFields: ['reservationId'] },
        Transaction: { keyFields: ['transactionId'] },
        FeatureFlag: { keyFields: ['key'] },
        Connector: { keyFields: false },
        Wallet: { keyFields: ['fleetId'] },
      },
    }),
    defaultOptions: {
      watchQuery: { fetchPolicy: 'cache-and-network' },
    },
  });
}
