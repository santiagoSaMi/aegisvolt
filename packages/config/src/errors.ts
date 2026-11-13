export interface ConfigIssue {
  /** Nombre de la variable de entorno afectada. */
  readonly variable: string;
  readonly message: string;
}

/**
 * Configuración inválida al arrancar. El mensaje lista las variables afectadas
 * pero nunca sus valores (podrían ser secretos).
 */
export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Configuración inválida: ${issues.map((issue) => `${issue.variable} (${issue.message})`).join('; ')}`,
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}
