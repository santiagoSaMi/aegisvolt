import type { Session } from './cognito-client.ts';

const KEY = 'aegisvolt.session';

/**
 * Sesión en `sessionStorage`: sobrevive a recargas, se borra al cerrar la
 * pestaña y nunca guarda la contraseña. El token se descarta al vencer.
 * (Compromiso documentado: un XSS podría leerlo; se mitiga sin HTML inyectado,
 * sin dependencias de terceros en tiempo de ejecución y con CSP en nginx.)
 */
export const sessionStore = {
  load(now: number = Date.now(), storage: Storage = sessionStorage): Session | undefined {
    try {
      const raw = storage.getItem(KEY);
      if (raw === null) {
        return undefined;
      }
      const session = JSON.parse(raw) as Session;
      if (typeof session.idToken !== 'string' || session.expiresAt <= now) {
        storage.removeItem(KEY);
        return undefined;
      }
      return session;
    } catch {
      return undefined;
    }
  },
  save(session: Session, storage: Storage = sessionStorage): void {
    storage.setItem(KEY, JSON.stringify(session));
  },
  clear(storage: Storage = sessionStorage): void {
    storage.removeItem(KEY);
  },
};
