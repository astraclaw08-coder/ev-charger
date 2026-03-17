import { createContext, useContext, useMemo, useState } from 'react';

export type PortalRangePreset = '7d' | '30d' | '60d';

type ScopeValue = {
  siteId: string;
  setSiteId: (id: string) => void;
  rangePreset: PortalRangePreset;
  setRangePreset: (preset: PortalRangePreset) => void;
};

const SITE_KEY = 'portal.scope.siteId';
const RANGE_KEY = 'portal.scope.range';

const PortalScopeContext = createContext<ScopeValue | null>(null);

export function PortalScopeProvider({ children }: { children: React.ReactNode }) {
  const [siteId, setSiteIdState] = useState<string>(() => (typeof window !== 'undefined' ? window.localStorage.getItem(SITE_KEY) ?? '' : ''));
  const [rangePreset, setRangePresetState] = useState<PortalRangePreset>(() => {
    if (typeof window === 'undefined') return '30d';
    const raw = window.localStorage.getItem(RANGE_KEY);
    return raw === '7d' || raw === '30d' || raw === '60d' ? raw : '30d';
  });

  const value = useMemo<ScopeValue>(() => ({
    siteId,
    setSiteId: (id) => {
      setSiteIdState(id);
      if (typeof window !== 'undefined') window.localStorage.setItem(SITE_KEY, id);
    },
    rangePreset,
    setRangePreset: (preset) => {
      setRangePresetState(preset);
      if (typeof window !== 'undefined') window.localStorage.setItem(RANGE_KEY, preset);
    },
  }), [siteId, rangePreset]);

  return <PortalScopeContext.Provider value={value}>{children}</PortalScopeContext.Provider>;
}

export function usePortalScope() {
  const ctx = useContext(PortalScopeContext);
  if (!ctx) throw new Error('usePortalScope must be used inside PortalScopeProvider');
  return ctx;
}
