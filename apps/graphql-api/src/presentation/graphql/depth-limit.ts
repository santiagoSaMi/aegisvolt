import {
  GraphQLError,
  Kind,
  type ASTVisitor,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';

/**
 * Regla de validación: rechaza documentos más profundos que `maxDepth` (incluye
 * fragmentos). Evita consultas anidadas que multipliquen llamadas a los
 * servicios. Se aplica antes de ejecutar nada.
 */
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of context.getDocument().definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(definition.name.value, definition);
      }
    }

    const depthOf = (selectionSet: SelectionSetNode, visited: Set<string>): number => {
      let max = 0;
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          const child =
            selection.selectionSet === undefined ? 0 : depthOf(selection.selectionSet, visited);
          max = Math.max(max, 1 + child);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          max = Math.max(max, depthOf(selection.selectionSet, visited));
        } else {
          const name = selection.name.value;
          const fragment = fragments.get(name);
          if (fragment !== undefined && !visited.has(name)) {
            max = Math.max(max, depthOf(fragment.selectionSet, new Set([...visited, name])));
          }
        }
      }
      return max;
    };

    return {
      OperationDefinition(node) {
        const depth = depthOf(node.selectionSet, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `La consulta tiene profundidad ${String(depth)}; el máximo es ${String(maxDepth)}`,
              { nodes: [node] },
            ),
          );
        }
      },
    };
  };
}
