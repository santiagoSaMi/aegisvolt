import { createContext, useContext } from 'react';

import type { Session } from './cognito-client.ts';

export interface AuthState {
  readonly session: Session | undefined;
  readonly signIn: (username: string, password: string) => Promise<void>;
  readonly signOut: () => void;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (state === undefined) {
    throw new Error('useAuth requiere AuthProvider');
  }
  return state;
}
