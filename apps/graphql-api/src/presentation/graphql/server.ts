import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDisableSuggestions } from '@apollo/server/plugin/disableSuggestions';
import {
  ApolloServerPluginLandingPageDisabled,
  ApolloServerPluginSchemaReportingDisabled,
  ApolloServerPluginUsageReportingDisabled,
} from '@apollo/server/plugin/disabled';
import type { Logger } from '@aegisvolt/logger';

import { depthLimit } from './depth-limit.ts';
import { createErrorFormatter } from './errors.ts';
import { resolvers, type GraphqlContext } from './resolvers.ts';
import { typeDefs } from './schema.ts';

export interface GraphqlServerOptions {
  readonly logger: Logger;
  /** Introspección (y sugerencias "did you mean"): habilitada fuera de prod. */
  readonly introspection: boolean;
  /** Profundidad máxima de un documento. */
  readonly maxDepth: number;
}

/**
 * Servidor Apollo (sin transporte: lo monta Express). Endurecido:
 * - sin stack traces en las respuestas y con formato de errores centralizado;
 * - límite de profundidad;
 * - protección CSRF de Apollo activa (exige Content-Type JSON o cabecera de preflight);
 * - sin landing page remota ni reporte a Apollo (ningún dato sale del clúster);
 * - sin introspección ni sugerencias en prod.
 */
export function createGraphqlServer(options: GraphqlServerOptions): ApolloServer<GraphqlContext> {
  return new ApolloServer<GraphqlContext>({
    typeDefs,
    resolvers,
    introspection: options.introspection,
    includeStacktraceInErrorResponses: false,
    formatError: createErrorFormatter(options.logger),
    validationRules: [depthLimit(options.maxDepth)],
    csrfPrevention: true,
    plugins: [
      ApolloServerPluginLandingPageDisabled(),
      ApolloServerPluginUsageReportingDisabled(),
      ApolloServerPluginSchemaReportingDisabled(),
      ...(options.introspection ? [] : [ApolloServerPluginDisableSuggestions()]),
    ],
  });
}
