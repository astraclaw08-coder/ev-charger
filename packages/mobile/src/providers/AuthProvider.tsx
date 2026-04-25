import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { api, authMode, isDevMode, isKeycloakMode, setAuthExpiredHandler, setAuthRefreshHandler, setBearerToken, setGuestMode } from '@/lib/api';
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
  loginWithOtp?: (accessToken: string, expiresIn: number, phone?: string) => Promise<boolean>;
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
  /** Phone number used for OTP sign-in — stored for silent re-auth */
  otpPhone?: string;
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
        // Token expired or expiring soon — try refresh
        const refreshed = await refreshSession(parsed);
        if (!refreshed) {
          // No refresh token available (OTP sessions don't have one)
          // Keep session stored so index.tsx still routes to tabs,
          // but the 401-retry handler will trigger silent re-auth
          if (parsed.otpPhone) {
            // Attempt silent OTP re-auth
            const reauthed = await preSeedOtpChallenge(parsed.otpPhone);
            if (reauthed) return;
          }
          // Couldn't re-auth — clear and redirect to sign-in
          await clearSession();
          return;
        }
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

  /**
   * NOT silent — the name is misleading history. This function pre-seeds a
   * fresh OTP challenge (sends the SMS and stores the challengeId) so that
   * when the user lands on the sign-in screen after their session expired,
   * they skip phone-number entry and go straight to code entry. No token
   * is obtained here; the user must still type the code from their phone.
   */
  const preSeedOtpChallenge = async (phone: string): Promise<boolean> => {
    try {
      const result = await api.auth.otpSend(phone);
      // We can't auto-verify without the code — redirect to sign-in with context
      // Store the pending challenge so sign-in can pick it up
      await SecureStore.setItemAsync(
        'mobile.pending-otp-reauth.v1',
        JSON.stringify({
          phone,
          challengeId: result.challengeId,
          resendCooldown: result.resendAvailableInSeconds,
        }),
      );
      return false; // Still needs user code entry
    } catch {
      return false;
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
      // Try standard token refresh first (password sessions with refresh tokens)
      const next = await refreshSession(active);
      if (next?.accessToken) return true;
      // No refresh token — for OTP sessions, pre-seed a fresh OTP challenge so
      // the user lands on the code-entry screen instead of phone-entry. Does
      // NOT return a usable token (user must still enter the code).
      if (active.otpPhone) {
        await preSeedOtpChallenge(active.otpPhone);
      }
      return false;
    });

    return () => setAuthRefreshHandler(null);
  }, []);

  // ── Session-expired handler ─────────────────────────────────────────────
  // Fired by api.ts request() when a protected call 401s AND refresh returned
  // false. Responsibility: clear invalid auth state, route to sign-in, and
  // signal the banner. The guard against navigating while already on the
  // sign-in screen prevents redirect loops if multiple in-flight requests
  // all 401 at the same instant.
  const expiredHandledRef = useRef(false);
  useEffect(() => {
    setAuthExpiredHandler(() => {
      if (expiredHandledRef.current) return;
      expiredHandledRef.current = true;
      (async () => {
        try {
          // Pre-seed OTP challenge if applicable so sign-in screen can skip
          // phone-entry. Fire-and-forget — don't block the redirect on it.
          const active = sessionRef.current;
          if (active?.otpPhone) {
            void preSeedOtpChallenge(active.otpPhone);
          }
          await clearSession();
        } finally {
          // expo-router: use replace so user can't back-navigate into a dead
          // protected screen. Pass a query param so sign-in can render the
          // "Session expired" banner.
          router.replace({ pathname: '/(auth)/sign-in', params: { expired: '1' } } as any);
          // Allow a follow-up expiration to re-fire after the user signs in.
          setTimeout(() => { expiredHandledRef.current = false; }, 2_000);
        }
      })();
    });
    return () => setAuthExpiredHandler(null);
  }, [router]);

  // ── Active-session keepalive ─────────────────────────────────────────────
  // Proactively refresh the Keycloak access token while the app is in the
  // foreground. Without this, the first 401 happens only at expiry — the
  // user hits it mid-action (e.g. confirming a reservation) and the refresh
  // race creates a visible failure. This refreshes 2 minutes before expiry
  // if the app is active. Stops when the app backgrounds.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let appStateSub: { remove: () => void } | null = null;

    const tryProactiveRefresh = async () => {
      const active = sessionRef.current;
      if (!active?.accessToken || !active.refreshToken) return; // OTP-only: no-op
      const msRemaining = active.expiresAtMs - Date.now();
      // Refresh if <2min left and we're not already refreshing.
      if (msRemaining < 120_000 && !refreshingRef.current) {
        await refreshSession(active);
      }
    };

    const startKeepalive = () => {
      if (intervalId) return;
      // Fire once immediately on foreground so a just-resumed app doesn't
      // wait up to 60s to refresh a token that's already almost expired.
      void tryProactiveRefresh();
      intervalId = setInterval(() => { void tryProactiveRefresh(); }, 60_000);
    };

    const stopKeepalive = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    };

    // Start immediately if app is active
    if (AppState.currentState === 'active') startKeepalive();

    appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') startKeepalive();
      else stopKeepalive();
    });

    return () => {
      stopKeepalive();
      appStateSub?.remove();
    };
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
    loginWithOtp: async (accessToken: string, expiresIn: number, phone?: string) => {
      setLoading(true);
      setError(null);
      try {
        const next: PasswordSession = {
          accessToken,
          expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
          provider: 'keycloak-password' as const,
          otpPhone: phone || undefined,
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
