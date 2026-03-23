import React, { createContext, useContext } from 'react';
import { usePasswordAuth } from './PasswordAuthContext';

type GetToken = () => Promise<string | null>;
const TokenContext = createContext<GetToken>(async () => null);

export function useToken(): GetToken {
  return useContext(TokenContext);
}

// Keycloak/password mode — returns password-login JWT if available.
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

// Dev mode — always returns null
export function DevTokenProvider({ children }: { children: React.ReactNode }) {
  return (
    <TokenContext.Provider value={async () => null}>
      {children}
    </TokenContext.Provider>
  );
}
