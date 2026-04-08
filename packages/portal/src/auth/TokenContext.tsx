import React, { createContext, useContext } from 'react';
import { usePasswordAuth } from './PasswordAuthContext';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

type GetToken = () => Promise<string | null>;
const TokenContext = createContext<GetToken>(async () => null);

export function useToken(): GetToken {
  return useContext(TokenContext);
}

// Keycloak/password mode — returns password-login JWT, auto-refreshing if expired.
export function PasswordTokenProvider({ children }: { children: React.ReactNode }) {
  const { session, logoutPassword } = usePasswordAuth();
  const refreshingRef = React.useRef<Promise<string | null> | null>(null);

  const getToken = React.useCallback(async (): Promise<string | null> => {
    if (!session) return null;

    // Token still valid — return it
    if (session.expiresAtMs > Date.now()) {
      return session.accessToken;
    }

    // Token expired — try inline refresh (deduplicated)
    if (!refreshingRef.current) {
      refreshingRef.current = (async () => {
        try {
          const canRefresh = !!session.refreshToken &&
            (!session.refreshExpiresAtMs || session.refreshExpiresAtMs > Date.now());
          if (!canRefresh) {
            logoutPassword();
            return null;
          }

          const res = await fetch(`${API_URL}/auth/password-refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: session.refreshToken }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !(json as { accessToken?: string }).accessToken) {
            logoutPassword();
            return null;
          }
          return (json as { accessToken: string }).accessToken;
        } catch {
          return session.accessToken; // Fallback: let server decide
        } finally {
          refreshingRef.current = null;
        }
      })();
    }

    return refreshingRef.current;
  }, [session, logoutPassword]);

  return (
    <TokenContext.Provider value={getToken}>
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
