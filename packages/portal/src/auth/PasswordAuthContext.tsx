import React, { createContext, useContext } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const STORAGE_KEY = 'portal.passwordAuth.session.v1';

export type PasswordAuthSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  provider: 'keycloak-password';
};

type PasswordAuthContextValue = {
  session: PasswordAuthSession | null;
  loading: boolean;
  error: string | null;
  loginWithPassword: (username: string, password: string) => Promise<boolean>;
  logoutPassword: () => void;
};

const PasswordAuthContext = createContext<PasswordAuthContextValue>({
  session: null,
  loading: false,
  error: null,
  loginWithPassword: async () => false,
  logoutPassword: () => {},
});

export function usePasswordAuth() {
  return useContext(PasswordAuthContext);
}

function safeReadStoredSession(): PasswordAuthSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PasswordAuthSession;
    if (!parsed?.accessToken || !parsed?.expiresAtMs) return null;
    if (parsed.expiresAtMs <= Date.now()) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function PasswordAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<PasswordAuthSession | null>(() => safeReadStoredSession());
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const persistSession = React.useCallback((next: PasswordAuthSession | null) => {
    setSession(next);
    if (typeof window === 'undefined') return;
    if (!next) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const logoutPassword = React.useCallback(() => {
    persistSession(null);
    setError(null);
  }, [persistSession]);

  const loginWithPassword = React.useCallback(async (username: string, password: string) => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/auth/password-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.accessToken) {
        const message = (json as { error?: string }).error ?? 'Username/password sign-in failed';
        throw new Error(message);
      }

      const expiresInSeconds = Number((json as { expiresIn?: number }).expiresIn ?? 900);
      const expiresAtMs = Date.now() + Math.max(60, expiresInSeconds) * 1000;
      const nextSession: PasswordAuthSession = {
        accessToken: (json as { accessToken: string }).accessToken,
        refreshToken: (json as { refreshToken?: string }).refreshToken,
        expiresAtMs,
        provider: 'keycloak-password',
      };

      persistSession(nextSession);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Username/password sign-in failed';
      setError(msg);
      persistSession(null);
      return false;
    } finally {
      setLoading(false);
    }
  }, [persistSession]);

  return (
    <PasswordAuthContext.Provider value={{ session, loading, error, loginWithPassword, logoutPassword }}>
      {children}
    </PasswordAuthContext.Provider>
  );
}
