import React, { createContext, useContext } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { usePasswordAuth } from './PasswordAuthContext';

// Provides a `getToken` function throughout the app.
// In dev mode, `getToken` returns null (API uses x-dev-operator-id instead).
// In production mode, it can return either Clerk JWT or password-login JWT.

type GetToken = () => Promise<string | null>;
const TokenContext = createContext<GetToken>(async () => null);

export function useToken(): GetToken {
  return useContext(TokenContext);
}

// Wrapper used inside <ClerkProvider> — reads Clerk token first, then password session token.
export function HybridTokenProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  const { session } = usePasswordAuth();

  return (
    <TokenContext.Provider
      value={async () => {
        const clerk = await getToken();
        if (clerk) return clerk;
        if (!session) return null;
        if (session.expiresAtMs <= Date.now()) return null;
        return session.accessToken;
      }}
    >
      {children}
    </TokenContext.Provider>
  );
}

// Wrapper used in keycloak-only mode — returns password-login JWT if available.
export function PasswordTokenProvider({ children }: { children: React.ReactNode }) {
  const { session } = usePasswordAuth();

  return (
    <TokenContext.Provider
      value={async () => {
        if (!session) return null;
        if (session.expiresAtMs <= Date.now()) return null;
        return session.accessToken;
      }}
    >
      {children}
    </TokenContext.Provider>
  );
}

// Wrapper used in dev mode — always returns null
export function DevTokenProvider({ children }: { children: React.ReactNode }) {
  return (
    <TokenContext.Provider value={async () => null}>
      {children}
    </TokenContext.Provider>
  );
}
