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

  function applyThemeClass(nextTheme: PortalTheme) {
    const enableDark = nextTheme === 'dark';
    document.documentElement.classList.toggle('dark', enableDark);
    document.body.classList.toggle('dark', enableDark);
    document.getElementById('root')?.classList.toggle('dark', enableDark);
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, theme);
      applyThemeClass(theme);
    }
  }, [theme]);

  // Sync on mount and preserve OS light preference on first visit.
  // If no saved theme exists, mirror the same initializer logic instead of forcing dark.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const initial = saved === 'light' || saved === 'dark'
        ? saved
        : (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      applyThemeClass(initial);
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
