import React, { createContext, useContext } from 'react';
import { useAuth, useSignIn } from '@clerk/clerk-react';
import { type AuthProvider, buildAuthProviderContract } from './providerContracts';

export type AuthSessionStatus = 'signed-in' | 'signed-out' | 'loading' | 'error';

type AuthUxState = {
  sessionStatus: AuthSessionStatus;
  providerLoading: AuthProvider | null;
  lastError: string | null;
  providerEnabled: boolean;
  signInWithProvider: (provider: AuthProvider) => Promise<void>;
};

const AuthUxContext = createContext<AuthUxState>({
  sessionStatus: 'loading',
  providerLoading: null,
  lastError: null,
  providerEnabled: false,
  signInWithProvider: async () => {},
});

export function useAuthUx(): AuthUxState {
  return useContext(AuthUxContext);
}

export function ClerkAuthUxProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoaded: signInLoaded, signIn } = useSignIn();
  const [providerLoading, setProviderLoading] = React.useState<AuthProvider | null>(null);
  const [lastError, setLastError] = React.useState<string | null>(null);

  const sessionStatus: AuthSessionStatus = !isLoaded
    ? 'loading'
    : isSignedIn
      ? 'signed-in'
      : 'signed-out';

  const signInWithProvider = React.useCallback(async (provider: AuthProvider) => {
    if (!signInLoaded || !signIn) return;

    setProviderLoading(provider);
    setLastError(null);

    try {
      const contract = buildAuthProviderContract(provider);
      await signIn.authenticateWithRedirect({
        strategy: contract.strategy,
        redirectUrl: '/sso-callback',
        redirectUrlComplete: contract.redirectUrl,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Unable to start ${provider} sign-in`;
      setLastError(msg);
    } finally {
      setProviderLoading(null);
    }
  }, [signIn, signInLoaded]);

  return (
    <AuthUxContext.Provider
      value={{
        sessionStatus,
        providerLoading,
        lastError,
        providerEnabled: Boolean(signInLoaded && signIn),
        signInWithProvider,
      }}
    >
      {children}
    </AuthUxContext.Provider>
  );
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
