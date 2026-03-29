import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { api, authMode, isDevMode, isKeycloakMode, setAuthRefreshHandler, setBearerToken, setGuestMode } from '@/lib/api';
import { clearFavorites } from '@/lib/favorites';
import {
  authenticateWithBiometrics,
  getBiometricLabel,
  isBiometricAvailable,
  isBiometricEnabled,
  setBiometricEnabled,
} from '@/lib/biometrics';

type AppAuthContextValue = {
  isGuest: boolean;
  loading: boolean;
  error: string | null;
  signOut: () => void;
  continueAsGuest?: () => void;
  signIn?: () => void;
  loginWithPassword?: (username: string, password: string) => Promise<boolean>;
  loginWithOtp?: (accessToken: string, expiresIn: number) => Promise<boolean>;
  // Biometric
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  biometricLabel: string;
  toggleBiometric: () => Promise<void>;
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
    continueAsGuest: () => setIsGuest(true),
    signIn: () => setIsGuest(false),
    biometricAvailable: false,
    biometricEnabled: false,
    biometricLabel: 'Biometrics',
    toggleBiometric: async () => {},
  };

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

function KeycloakAuthProvider({ children }: { children: React.ReactNode }) {
  const SecureStore = require('expo-secure-store');
  const router = useRouter();
  const [session, setSession] = useState<PasswordSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const sessionRef = useRef<PasswordSession | null>(null);

  // Biometric state
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState('Biometrics');
  const biometricCheckedRef = useRef(false);

  const persistSession = async (next: PasswordSession | null) => {
    sessionRef.current = next;
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
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    restoreSession();
    // Initialize biometric state
    (async () => {
      const available = await isBiometricAvailable();
      setBiometricAvailable(available);
      if (available) {
        const label = await getBiometricLabel();
        setBiometricLabel(label);
        const enabled = await isBiometricEnabled();
        setBiometricEnabledState(enabled);
      }
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState) => {
      if (nextState !== 'active') {
        // Reset biometric check when app goes to background
        biometricCheckedRef.current = false;
        return;
      }
      if (!session) return;
      // Refresh token if near expiry
      if (session.expiresAtMs <= Date.now() + 60_000) {
        refreshSession(session);
      }
      // Biometric re-authentication on app resume (only once per foreground cycle)
      if (biometricEnabled && !biometricCheckedRef.current) {
        biometricCheckedRef.current = true;
        const result = await authenticateWithBiometrics(`Unlock with ${biometricLabel}`);
        if (!result.success) {
          // Lock the user out — clear bearer but keep session stored so they can retry
          setBearerToken(null);
          setGuestMode(true);
        }
      }
    });
    return () => sub.remove();
  }, [session, biometricEnabled, biometricLabel]);

  useEffect(() => {
    setAuthRefreshHandler(async () => {
      const active = sessionRef.current;
      if (!active) return false;
      const next = await refreshSession(active);
      return Boolean(next?.accessToken);
    });

    return () => setAuthRefreshHandler(null);
  }, []);

  const toggleBiometricRef = useRef<(() => Promise<void>) | undefined>(undefined);
  toggleBiometricRef.current = async () => {
    if (!biometricAvailable) return;
    if (biometricEnabled) {
      await setBiometricEnabled(false);
      setBiometricEnabledState(false);
    } else {
      const result = await authenticateWithBiometrics(`Enable ${biometricLabel}`);
      if (result.success) {
        await setBiometricEnabled(true);
        setBiometricEnabledState(true);
      }
    }
  };
  const toggleBiometric = useMemo(() => async () => { await toggleBiometricRef.current?.(); }, []);

  const value: AppAuthContextValue = useMemo(() => ({
    isGuest: !session?.accessToken,
    loading,
    error,
    biometricAvailable,
    biometricEnabled,
    biometricLabel,
    toggleBiometric,
    loginWithOtp: async (accessToken: string, expiresIn: number) => {
      setLoading(true);
      setError(null);
      try {
        const next: PasswordSession = {
          accessToken,
          expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
          provider: 'keycloak-password' as const, // reuse session type — bearer token works the same
        };
        await persistSession(next);
        setBearerToken(next.accessToken);
        setGuestMode(false);
        return true;
      } catch (err) {
        await clearSession();
        setError(err instanceof Error ? err.message : 'OTP sign-in failed');
        return false;
      } finally {
        setLoading(false);
      }
    },
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
    continueAsGuest: () => {
      setBearerToken(null);
      setGuestMode(true);
      router.replace('/(tabs)' as any);
    },
    signOut: () => {
      clearSession().finally(() => {
        clearFavorites().finally(() => {
          router.replace('/(auth)/sign-in');
        });
      });
    },
  }), [session?.accessToken, loading, error, router, biometricAvailable, biometricEnabled, biometricLabel]);

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}


export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <KeycloakAuthProvider>{children}</KeycloakAuthProvider>;
}

export function useAppAuth() {
  const ctx = useContext(AppAuthContext);
  return (
    ctx ?? {
      isGuest: false,
      loading: false,
      error: null,
      continueAsGuest: () => {},
      signOut: () => {},
      biometricAvailable: false,
      biometricEnabled: false,
      biometricLabel: 'Biometrics',
      toggleBiometric: async () => {},
    }
  );
}
