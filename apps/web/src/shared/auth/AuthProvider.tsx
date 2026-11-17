import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { AuthContext } from './auth-context.ts';
import type { CognitoClient, Session } from './cognito-client.ts';
import { sessionStore } from './session-store.ts';

/** Sesión del usuario (ID token de Cognito en sessionStorage, nunca en el bundle). */
export function AuthProvider({
  cognito,
  initialSession,
  children,
}: {
  cognito: CognitoClient;
  initialSession?: Session | undefined;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | undefined>(
    () => initialSession ?? sessionStore.load(),
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      const next = await cognito.signIn(username, password);
      sessionStore.save(next);
      setSession(next);
    },
    [cognito],
  );
  const signOut = useCallback(() => {
    sessionStore.clear();
    setSession(undefined);
  }, []);

  const value = useMemo(() => ({ session, signIn, signOut }), [session, signIn, signOut]);
  return <AuthContext value={value}>{children}</AuthContext>;
}
