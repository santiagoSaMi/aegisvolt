import type { Principal } from '../authorization.ts';

/**
 * Verificación de la identidad de quien llama (ADR-0008). La presentación la usa
 * para construir el `Principal` del contexto; si el token no es válido lanza
 * `UnauthorizedError`.
 */
export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}
