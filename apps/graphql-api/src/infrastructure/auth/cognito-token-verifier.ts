import { fleetIdSchema } from '@aegisvolt/contracts';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { UnauthorizedError, type Principal, type TokenVerifier } from '../../application/index.ts';

export interface CognitoTokenVerifierOptions {
  /** `iss` esperado (en Floci: `http://floci:4566/<poolId>`). */
  readonly issuer: string;
  /** App client del User Pool del ambiente: `aud` del ID token. */
  readonly clientId: string;
  /** URL del JWKS (puede diferir del host del `iss`, p. ej. `http://localhost:4566/<poolId>/.well-known/jwks.json`). */
  readonly jwksUrl?: string;
  /** Claves inyectadas (pruebas). */
  readonly keys?: JWTVerifyGetKey;
  /** Tolerancia de reloj. */
  readonly clockToleranceSec?: number;
}

/**
 * Verifica ID tokens de Cognito (ADR-0008): firma RS256 contra el JWKS del User
 * Pool DEL AMBIENTE, `iss`, `aud` (client id), `exp` y `token_use = id`. Un
 * token de otro ambiente falla por `iss`/`aud`/firma. Los grupos y la flota
 * salen de claims firmados (`cognito:groups`, `custom:fleet_id`), nunca de lo
 * que el cliente declare.
 */
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly options: CognitoTokenVerifierOptions;
  private readonly keys: JWTVerifyGetKey;

  constructor(options: CognitoTokenVerifierOptions) {
    this.options = options;
    if (options.keys !== undefined) {
      this.keys = options.keys;
    } else if (options.jwksUrl !== undefined) {
      // Caché del JWKS y recarga ante un `kid` desconocido (rotación de claves).
      this.keys = createRemoteJWKSet(new URL(options.jwksUrl), {
        timeoutDuration: 2_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      });
    } else {
      throw new Error('CognitoTokenVerifier requiere jwksUrl o keys');
    }
  }

  async verify(token: string): Promise<Principal> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.clientId,
        algorithms: ['RS256'],
        clockTolerance: this.options.clockToleranceSec ?? 5,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      throw new UnauthorizedError('Token inválido o vencido', { cause: error });
    }
    if (payload.token_use !== 'id') {
      throw new UnauthorizedError('Se requiere un ID token de Cognito');
    }
    const groupsClaim = payload['cognito:groups'];
    const groups = Array.isArray(groupsClaim)
      ? groupsClaim.filter((g): g is string => typeof g === 'string')
      : [];
    const fleet = fleetIdSchema.safeParse(payload['custom:fleet_id']);
    return {
      subject: String(payload.sub),
      groups,
      ...(fleet.success ? { fleetId: fleet.data } : {}),
    };
  }
}
