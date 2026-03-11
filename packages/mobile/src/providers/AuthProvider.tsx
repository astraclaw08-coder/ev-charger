import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { api, authMode, isDevMode, isKeycloakMode, setBearerToken, setGuestMode } from '@/lib/api';
import { clearFavorites } from '@/lib/favorites';

type AppAuthContextValue = {
  isGuest: boolean;
  loading: boolean;
  error: string | null;
  signOut: () => void;
  signIn?: () => void;
  loginWithPassword?: (username: string, password: string) => Promise<boolean>;
};

type PasswordSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  provider: 'keycloak-password';
};

const PASSWORD_SESSION_KEY = 'mobile.keycloak.session.v1';
const AppAuthContext = createContext<AppAuthContextValue | null>(null);

function DevAuthProvider({ children }: { children: React.ReactNode }) {
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    setGuestMode(isGuest);
  }, [isGuest]);

  const value: AppAuthContextValue = {
    isGuest,
    loading: false,
    error: null,
    signOut: () => {
      clearFavorites().finally(() => setIsGuest(true));
    },
    signIn: () => setIsGuest(false),
  };

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

function KeycloakAuthProvider({ children }: { children: React.ReactNode }) {
  const SecureStore = require('expo-secure-store');
  const router = useRouter();
  const segments = useSegments();
  const [session, setSession] = useState<PasswordSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshingRef = useRef(false);

  const persistSession = async (next: PasswordSession | null) => {
    setSession(next);
    if (!next) {
      await SecureStore.deleteItemAsync(PASSWORD_SESSION_KEY).catch(() => {});
      return;
    }
    await SecureStore.setItemAsync(PASSWORD_SESSION_KEY, JSON.stringify(next));
  };

  const clearSession = async () => {
    await persistSession(null);
    setBearerToken(null);
    setGuestMode(true);
  };

  const fromTokenPayload = (payload: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    refreshExpiresIn?: number;
  }): PasswordSession => ({
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    expiresAtMs: Date.now() + Math.max(60, Number(payload.expiresIn ?? 900)) * 1000,
    refreshExpiresAtMs: payload.refreshToken
      ? Date.now() + Math.max(60, Number(payload.refreshExpiresIn ?? 0)) * 1000
      : undefined,
    provider: 'keycloak-password',
  });

  const refreshSession = async (active: PasswordSession): Promise<PasswordSession | null> => {
    const canRefresh = !!active.refreshToken && (!active.refreshExpiresAtMs || active.refreshExpiresAtMs > Date.now());
    if (!canRefresh || refreshingRef.current) return null;

    refreshingRef.current = true;
    try {
      const refreshed = await api.auth.passwordRefresh(active.refreshToken!);
      const next = fromTokenPayload({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? active.refreshToken,
        expiresIn: refreshed.expiresIn,
        refreshExpiresIn: refreshed.refreshExpiresIn,
      });
      await persistSession(next);
      setBearerToken(next.accessToken);
      setGuestMode(false);
      return next;
    } catch {
      await clearSession();
      return null;
    } finally {
      refreshingRef.current = false;
    }
  };

  const restoreSession = async () => {
    setLoading(true);
    try {
      const raw = await SecureStore.getItemAsync(PASSWORD_SESSION_KEY);
      if (!raw) {
        await clearSession();
        return;
      }
      const parsed = JSON.parse(raw) as PasswordSession;
      if (!parsed?.accessToken || !parsed?.expiresAtMs) {
        await clearSession();
        return;
      }

      if (parsed.expiresAtMs <= Date.now() + 30_000) {
        const refreshed = await refreshSession(parsed);
        if (!refreshed) return;
      } else {
        setSession(parsed);
        setBearerToken(parsed.accessToken);
        setGuestMode(false);
      }
    } catch {
      await clearSession();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    restoreSession();
  }, []);

  useEffect(() => {
    if (loading) return;
    const inAuth = segments[0] === '(auth)';
    if (!session?.accessToken && !inAuth) {
      router.replace('/(auth)/sign-in');
    } else if (session?.accessToken && inAuth) {
      router.replace('/(tabs)/index' as any);
    }
  }, [loading, session?.accessToken, segments]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !session) return;
      if (session.expiresAtMs <= Date.now() + 60_000) {
        refreshSession(session);
      }
    });
    return () => sub.remove();
  }, [session]);

  const value: AppAuthContextValue = useMemo(() => ({
    isGuest: !session?.accessToken,
    loading,
    error,
    loginWithPassword: async (username: string, password: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.auth.passwordLogin(username.trim(), password);
        const next = fromTokenPayload(result);
        await persistSession(next);
        setBearerToken(next.accessToken);
        setGuestMode(false);
        return true;
      } catch (err) {
        await clearSession();
        setError(err instanceof Error ? err.message : 'Username/password sign-in failed');
        return false;
      } finally {
        setLoading(false);
      }
    },
    signOut: () => {
      clearSession().finally(() => {
        clearFavorites().finally(() => {
          router.replace('/(auth)/sign-in');
        });
      });
    },
  }), [session?.accessToken, loading, error, router]);

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

// Clerk mode
let ClerkProvider: React.ComponentType<{
  publishableKey: string;
  tokenCache: unknown;
  children: React.ReactNode;
}> | null = null;

let useAuth: (() => {
  isSignedIn: boolean | undefined;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}) | null = null;

try {
  const clerk = require('@clerk/clerk-expo');
  ClerkProvider = clerk.ClerkProvider;
  useAuth = clerk.useAuth;
} catch {
  // fallback
}

function ClerkAuthGuard({ children }: { children: React.ReactNode }) {
  const auth = useAuth!();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (auth.isSignedIn === undefined) return;
    const inAuth = segments[0] === '(auth)';

    if (!auth.isSignedIn && !inAuth) {
      router.replace('/(auth)/sign-in');
    } else if (auth.isSignedIn && inAuth) {
      router.replace('/(tabs)/index' as any);
    }
  }, [auth.isSignedIn, segments]);

  useEffect(() => {
    const guest = !auth.isSignedIn;
    setGuestMode(guest);

    if (guest) {
      setBearerToken(null);
      return;
    }
    auth.getToken().then((t) => {
      if (t) setBearerToken(t);
    });
  }, [auth.isSignedIn]);

  const value: AppAuthContextValue = {
    isGuest: !auth.isSignedIn,
    loading: auth.isSignedIn === undefined,
    error: null,
    signOut: () => {
      auth.signOut().finally(() => {
        setBearerToken(null);
        setGuestMode(true);
        clearFavorites().finally(() => {
          router.replace('/(auth)/sign-in');
        });
      });
    },
  };

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (isDevMode || authMode === 'dev') {
    return <DevAuthProvider>{children}</DevAuthProvider>;
  }

  if (isKeycloakMode) {
    return <KeycloakAuthProvider>{children}</KeycloakAuthProvider>;
  }

  if (!ClerkProvider) {
    return <DevAuthProvider>{children}</DevAuthProvider>;
  }

  const SecureStore = require('expo-secure-store');
  const tokenCache = {
    async getToken(key: string) {
      return SecureStore.getItemAsync(key);
    },
    async saveToken(key: string, value: string) {
      return SecureStore.setItemAsync(key, value);
    },
  };

  return (
    <ClerkProvider
      publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!}
      tokenCache={tokenCache}
    >
      <ClerkAuthGuard>{children}</ClerkAuthGuard>
    </ClerkProvider>
  );
}

export function useAppAuth() {
  const ctx = useContext(AppAuthContext);
  return (
    ctx ?? {
      isGuest: false,
      loading: false,
      error: null,
      signOut: () => {},
    }
  );
}
