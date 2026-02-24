/**
 * AuthProvider — wraps Clerk when a publishable key is configured, otherwise
 * runs in dev mode with a fixed test user.
 */
import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { setBearerToken, isDevMode } from '@/lib/api';

// ── Dev-mode stub ─────────────────────────────────────────────────────────────

const DevAuthContext = createContext<{ signOut: () => void } | null>(null);

function DevAuthProvider({ children }: { children: React.ReactNode }) {
  // Dev mode: always authenticated, no token needed (API uses x-dev-user-id header)
  return (
    <DevAuthContext.Provider value={{ signOut: () => {} }}>
      {children}
    </DevAuthContext.Provider>
  );
}

// ── Clerk-mode provider ───────────────────────────────────────────────────────

let ClerkProvider: React.ComponentType<{
  publishableKey: string;
  tokenCache: unknown;
  children: React.ReactNode;
}> | null = null;

let useAuth: (() => { isSignedIn: boolean | undefined; getToken: () => Promise<string | null> }) | null = null;

try {
  // Dynamic require so the app doesn't crash when CLERK_KEY is absent
  const clerk = require('@clerk/clerk-expo');
  ClerkProvider = clerk.ClerkProvider;
  useAuth = clerk.useAuth;
} catch {
  // Clerk not available (shouldn't happen since it's a dep, but safety net)
}

function ClerkAuthGuard({ children }: { children: React.ReactNode }) {
  const auth = useAuth!();
  const router = useRouter();
  const segments = useSegments();
  const tokenRefreshed = useRef(false);

  useEffect(() => {
    if (auth.isSignedIn === undefined) return; // still loading

    const inAuth = segments[0] === '(auth)';

    if (!auth.isSignedIn && !inAuth) {
      router.replace('/(auth)/sign-in');
    } else if (auth.isSignedIn && inAuth) {
      router.replace('/(tabs)/');
    }
  }, [auth.isSignedIn, segments]);

  useEffect(() => {
    if (!auth.isSignedIn) {
      setBearerToken(null);
      tokenRefreshed.current = false;
      return;
    }
    auth.getToken().then((t) => {
      if (t) setBearerToken(t);
    });
  }, [auth.isSignedIn]);

  return <>{children}</>;
}

// ── Unified export ────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (isDevMode || !ClerkProvider) {
    return <DevAuthProvider>{children}</DevAuthProvider>;
  }

  // Use expo-secure-store as the Clerk token cache
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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

export function useDevAuth() {
  return useContext(DevAuthContext);
}
