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
  /** `custom:fleet_id` del token: la única flota sobre la que opera un operador. */
  readonly fleetId?: string | undefined;
}

const isAdmin = (principal: Principal): boolean => principal.groups.includes(ADMIN_GROUP);

/**
 * Política de acceso a datos de una flota (ADR-0008):
 * - `platform-admins`: cualquier flota (debe indicarla);
 * - `fleet-operators`: solo la de su token; si no la indica, se usa esa.
 * Se aplica en los casos de uso, nunca en los resolvers.
 */
export const fleetPolicy = {
  /** Flota efectiva de la operación, o error si quien llama no puede acceder a ella. */
  resolveFleet(principal: Principal | undefined, requested: string | undefined): string {
    const caller = flagsPolicy.assertCanRead(principal);
    if (isAdmin(caller)) {
      if (requested === undefined) {
        throw new ForbiddenError('Un administrador debe indicar la flota (fleetId)');
      }
      return requested;
    }
    if (caller.fleetId === undefined) {
      throw new ForbiddenError('El usuario no tiene una flota asignada');
    }
    if (requested !== undefined && requested !== caller.fleetId) {
      throw new ForbiddenError('No puede operar sobre otra flota');
    }
    return caller.fleetId;
  },

  /** Verifica que un recurso de `fleetId` sea accesible para quien llama. */
  assertCanAccess(principal: Principal | undefined, fleetId: string): Principal {
    const caller = flagsPolicy.assertCanRead(principal);
    if (!isAdmin(caller) && caller.fleetId !== fleetId) {
      throw new ForbiddenError('El recurso pertenece a otra flota');
    }
    return caller;
  },

  isAdmin,
};

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
