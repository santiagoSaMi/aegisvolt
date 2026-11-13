import { ForbiddenError, UnauthorizedError } from './errors.ts';

/** Grupos de Cognito (ADR-0008). */
export const ADMIN_GROUP = 'platform-admins';
export const OPERATOR_GROUP = 'fleet-operators';

/**
 * Identidad YA VERIFICADA de quien llama (la construye la presentación a partir
 * del JWT de Cognito validado: firma, `iss`, `aud`, `exp`). Los casos de uso no
 * confían en nada que el cliente declare sobre sí mismo.
 */
export interface Principal {
  /** `sub` del token (identificador estable; se registra en la auditoría). */
  readonly subject: string;
  readonly groups: readonly string[];
}

/**
 * Política de autorización del módulo de flags, aplicada en la capa de
 * aplicación (no en los resolvers):
 * - leer: cualquier usuario autenticado de la plataforma;
 * - escribir: solo `platform-admins`.
 */
export const flagsPolicy = {
  assertCanRead(principal: Principal | undefined): Principal {
    if (principal === undefined || principal.subject.length === 0) {
      throw new UnauthorizedError('Se requiere una identidad verificada');
    }
    if (!principal.groups.some((g) => g === ADMIN_GROUP || g === OPERATOR_GROUP)) {
      throw new ForbiddenError('El usuario no pertenece a ningún grupo de la plataforma');
    }
    return principal;
  },

  assertCanWrite(principal: Principal | undefined): Principal {
    const reader = flagsPolicy.assertCanRead(principal);
    if (!reader.groups.includes(ADMIN_GROUP)) {
      throw new ForbiddenError(`Cambiar flags requiere el grupo ${ADMIN_GROUP}`);
    }
    return reader;
  },
};
