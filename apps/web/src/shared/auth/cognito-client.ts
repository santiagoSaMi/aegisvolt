/**
 * Autenticación contra Cognito (ADR-0008) con el flujo `USER_PASSWORD_AUTH` de la
 * API `cognito-idp`, a través de una ruta del MISMO origen que el despliegue
 * reenvía a Cognito (sin CORS). No usa secretos: el app client es público.
 * Las credenciales solo viajan en esta petición; nunca se guardan.
 */
export class AuthError extends Error {
  readonly kind: 'INVALID_CREDENTIALS' | 'CHALLENGE_REQUIRED' | 'UNAVAILABLE';

  constructor(kind: AuthError['kind'], message: string) {
    super(message);
    this.name = 'AuthError';
    this.kind = kind;
  }
}

export interface Session {
  readonly idToken: string;
  /** Instante de vencimiento (ms desde epoch). */
  readonly expiresAt: number;
  readonly username: string;
}

interface InitiateAuthResponse {
  AuthenticationResult?: { IdToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  __type?: string;
  message?: string;
}

export interface CognitoClientOptions {
  readonly cognitoUrl: string;
  readonly clientId: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function createCognitoClient(options: CognitoClientOptions) {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const now = options.now ?? Date.now;

  return {
    async signIn(username: string, password: string): Promise<Session> {
      let response: Response;
      try {
        response = await fetchImpl(options.cognitoUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-amz-json-1.1',
            'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
          },
          body: JSON.stringify({
            AuthFlow: 'USER_PASSWORD_AUTH',
            ClientId: options.clientId,
            AuthParameters: { USERNAME: username, PASSWORD: password },
          }),
        });
      } catch {
        throw new AuthError('UNAVAILABLE', 'No se pudo contactar el servicio de identidad');
      }
      const body = (await response.json().catch(() => ({}))) as InitiateAuthResponse;
      if (!response.ok) {
        const type = body.__type ?? '';
        if (type.includes('NotAuthorized') || type.includes('UserNotFound')) {
          throw new AuthError('INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos');
        }
        throw new AuthError('UNAVAILABLE', 'El servicio de identidad no respondió correctamente');
      }
      if (body.ChallengeName !== undefined) {
        throw new AuthError(
          'CHALLENGE_REQUIRED',
          'La cuenta requiere completar un paso adicional (p. ej. cambiar la contraseña)',
        );
      }
      const idToken = body.AuthenticationResult?.IdToken;
      if (idToken === undefined) {
        throw new AuthError('UNAVAILABLE', 'Respuesta de autenticación incompleta');
      }
      const expiresIn = body.AuthenticationResult?.ExpiresIn ?? 3_600;
      return { idToken, expiresAt: now() + expiresIn * 1_000, username };
    },
  };
}

export type CognitoClient = ReturnType<typeof createCognitoClient>;
