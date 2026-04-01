import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type PortalTheme = 'dark' | 'light';

const STORAGE_KEY = 'portal.theme';

type ThemeContextValue = {
  theme: PortalTheme;
  setTheme: (next: PortalTheme) => void;
  toggleTheme: () => void;
  themeClass: 'portal-dark' | 'portal-light';
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<PortalTheme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    // Respect OS preference on first visit
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, theme);
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  }, [theme]);

  // Sync on mount (effect doesn't run during SSR/initial hydration)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const initial = saved === 'light' || saved === 'dark' ? saved : 'dark';
      if (initial === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme: (next) => setThemeState(next),
    toggleTheme: () => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark')),
    themeClass: theme === 'dark' ? 'portal-dark' : 'portal-light',
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function usePortalTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('usePortalTheme must be used within ThemeProvider');
  }
  return ctx;
}
