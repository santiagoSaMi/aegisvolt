import { ApolloClient, InMemoryCache } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { MockLink } from '@apollo/client/testing';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import type { RuntimeConfig } from '../../src/config/runtime-config.ts';
import type { Viewer } from '../../src/shared/api/viewer.ts';
import { RuntimeConfigProvider } from '../../src/shared/config/RuntimeConfigProvider.tsx';
import { testConfig } from './fixtures.ts';
import { ViewerOutlet } from './ViewerOutlet.tsx';

/**
 * Renderiza una página con los mismos providers que la app, un Apollo Client
 * con `MockLink` (respuestas GraphQL controladas) y el viewer del layout.
 */
export function renderPage(
  page: ReactElement,
  options: {
    viewer: Viewer;
    mocks: readonly MockLink.MockedResponse[];
    path?: string;
    route?: string;
    config?: RuntimeConfig;
  },
) {
  const client = new ApolloClient({
    link: new MockLink(options.mocks, { showWarnings: false }),
    cache: new InMemoryCache({
      typePolicies: {
        Saga: { keyFields: ['sagaId'] },
        Station: { keyFields: ['stationId'] },
        Connector: { keyFields: false },
      },
    }),
  });
  const path = options.path ?? '/';
  return {
    client,
    ...render(
      <RuntimeConfigProvider config={options.config ?? testConfig}>
        <ApolloProvider client={client}>
          <MemoryRouter initialEntries={[options.route ?? path]}>
            <Routes>
              <Route element={<ViewerOutlet viewer={options.viewer} />}>
                <Route path={path} element={page} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ApolloProvider>
      </RuntimeConfigProvider>,
    ),
  };
}
