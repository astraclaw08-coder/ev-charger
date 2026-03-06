/**
 * AuthProvider — wraps Clerk when a publishable key is configured, otherwise
 * runs in dev mode with a guest toggle for local auth UX.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { setBearerToken, setGuestMode, isDevMode } from '@/lib/api';
import { clearFavorites } from '@/lib/favorites';

type AppAuthContextValue = {
  isGuest: boolean;
  signOut: () => void;
  signIn?: () => void;
};

// ── Dev-mode auth ────────────────────────────────────────────────────────────

const AppAuthContext = createContext<AppAuthContextValue | null>(null);

function DevAuthProvider({ children }: { children: React.ReactNode }) {
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    setGuestMode(isGuest);
  }, [isGuest]);

  const value: AppAuthContextValue = {
    isGuest,
    signOut: () => {
      clearFavorites().finally(() => setIsGuest(true));
    },
    signIn: () => setIsGuest(false),
  };

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

// ── Clerk-mode provider ──────────────────────────────────────────────────────

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
  // safety fallback
}

function ClerkAuthGuard({ children }: { children: React.ReactNode }) {
  const auth = useAuth!();
  const router = useRouter();
  const segments = useSegments();
  const tokenRefreshed = useRef(false);

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
      tokenRefreshed.current = false;
      return;
    }
    auth.getToken().then((t) => {
      if (t) setBearerToken(t);
    });
  }, [auth.isSignedIn]);

  const value: AppAuthContextValue = {
    isGuest: !auth.isSignedIn,
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

// ── Unified export ───────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (isDevMode || !ClerkProvider) {
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
      signOut: () => {},
    }
  );
}
