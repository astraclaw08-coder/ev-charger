import React, { createContext, useContext } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const STORAGE_KEY = 'portal.passwordAuth.session.v1';

export type PasswordAuthSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
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

  const refreshSession = React.useCallback(async (current: PasswordAuthSession): Promise<PasswordAuthSession | null> => {
    const canRefresh = !!current.refreshToken && (!current.refreshExpiresAtMs || current.refreshExpiresAtMs > Date.now());
    if (!canRefresh) return null;

    try {
      const res = await fetch(`${API_URL}/auth/password-refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !(json as { accessToken?: string }).accessToken) return null;

      const expiresInSeconds = Number((json as { expiresIn?: number }).expiresIn ?? 900);
      const refreshExpiresInSeconds = Number((json as { refreshExpiresIn?: number }).refreshExpiresIn ?? 1800);

      return {
        accessToken: (json as { accessToken: string }).accessToken,
        refreshToken: (json as { refreshToken?: string }).refreshToken ?? current.refreshToken,
        expiresAtMs: Date.now() + Math.max(60, expiresInSeconds) * 1000,
        refreshExpiresAtMs: Date.now() + Math.max(60, refreshExpiresInSeconds) * 1000,
        provider: 'keycloak-password',
      };
    } catch {
      return null;
    }
  }, []);

  const logoutPassword = React.useCallback(() => {
    persistSession(null);
    setError(null);
  }, [persistSession]);

  React.useEffect(() => {
    if (!session) return;

    let cancelled = false;
    const tick = async () => {
      if (!session) return;
      const timeLeft = session.expiresAtMs - Date.now();

      if (timeLeft <= 60_000) {
        const next = await refreshSession(session);
        if (cancelled) return;
        if (next) {
          persistSession(next);
          return;
        }
        // hard-expired or refresh failed -> logout so UI returns to sign-in instead of spamming unauthorized APIs
        logoutPassword();
      }
    };

    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [session, refreshSession, persistSession, logoutPassword]);

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
      const refreshExpiresInSeconds = Number((json as { refreshExpiresIn?: number }).refreshExpiresIn ?? 1800);
      const expiresAtMs = Date.now() + Math.max(60, expiresInSeconds) * 1000;
      const nextSession: PasswordAuthSession = {
        accessToken: (json as { accessToken: string }).accessToken,
        refreshToken: (json as { refreshToken?: string }).refreshToken,
        expiresAtMs,
        refreshExpiresAtMs: Date.now() + Math.max(60, refreshExpiresInSeconds) * 1000,
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
