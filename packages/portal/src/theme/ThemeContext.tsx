import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';

export type PortalTheme = 'dark' | 'light';

const STORAGE_KEY = 'portal.theme';

type ThemeContextValue = {
  theme: PortalTheme;
  setTheme: (next: PortalTheme) => void;
  toggleTheme: () => void;
  themeClass: 'portal-dark' | 'portal-light';
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Synchronously toggle the .dark class on every relevant DOM node. */
function applyThemeClass(nextTheme: PortalTheme) {
  if (typeof document === 'undefined') return;
  const enableDark = nextTheme === 'dark';
  document.documentElement.classList.toggle('dark', enableDark);
  document.body.classList.toggle('dark', enableDark);
  document.getElementById('root')?.classList.toggle('dark', enableDark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<PortalTheme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  // useLayoutEffect so the class swap happens synchronously before paint —
  // prevents a single dark-frame flash when switching to light.
  useLayoutEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, theme);
    applyThemeClass(theme);
  }, [theme]);

  const setTheme = useCallback((next: PortalTheme) => setThemeState(next), []);
  const toggleTheme = useCallback(() => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme,
    toggleTheme,
    themeClass: theme === 'dark' ? 'portal-dark' : 'portal-light',
  }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function usePortalTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('usePortalTheme must be used within ThemeProvider');
  }
  return ctx;
}
