import React, { createContext, useContext } from 'react';
import { useAuth } from '@clerk/clerk-react';

// Provides a `getToken` function throughout the app.
// In dev mode, `getToken` returns null (API uses x-dev-operator-id instead).
// In production mode (Clerk configured), it returns the signed-in user's JWT.

type GetToken = () => Promise<string | null>;
const TokenContext = createContext<GetToken>(async () => null);

export function useToken(): GetToken {
  return useContext(TokenContext);
}

// Wrapper used inside <ClerkProvider> — reads the real Clerk token
export function ClerkTokenProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  return (
    <TokenContext.Provider value={() => getToken()}>
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
