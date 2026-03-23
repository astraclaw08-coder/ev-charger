import React, { createContext, useContext } from 'react';
import { type AuthProvider } from './providerContracts';

export type AuthSessionStatus = 'signed-in' | 'signed-out' | 'loading' | 'error';

type AuthUxState = {
  sessionStatus: AuthSessionStatus;
  providerLoading: AuthProvider | null;
  lastError: string | null;
  providerEnabled: boolean;
  signInWithProvider: (provider: AuthProvider) => Promise<void>;
};

const AuthUxContext = createContext<AuthUxState>({
  sessionStatus: 'signed-out',
  providerLoading: null,
  lastError: null,
  providerEnabled: false,
  signInWithProvider: async () => {},
});

export function useAuthUx(): AuthUxState {
  return useContext(AuthUxContext);
}

export function DevAuthUxProvider({ children }: { children: React.ReactNode }) {
  return (
    <AuthUxContext.Provider
      value={{
        sessionStatus: 'signed-out',
        providerLoading: null,
        lastError: null,
        providerEnabled: false,
        signInWithProvider: async () => {},
      }}
    >
      {children}
    </AuthUxContext.Provider>
  );
}
