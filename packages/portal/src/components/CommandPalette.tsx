import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createApiClient } from '../api/client';
import { useToken } from '../auth/TokenContext';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
interface SearchResult {
  id: string;
  kind: 'site' | 'charger' | 'session' | 'page';
  title: string;
  subtitle?: string;
  href: string;
}

const PAGES: SearchResult[] = [
  { id: 'p-overview', kind: 'page', title: 'Overview', href: '/overview' },
  { id: 'p-sites', kind: 'page', title: 'Sites', href: '/sites' },
  { id: 'p-chargers', kind: 'page', title: 'Chargers', href: '/chargers' },
  { id: 'p-sessions', kind: 'page', title: 'Sessions', href: '/sessions' },
  { id: 'p-analytics', kind: 'page', title: 'Analytics', href: '/analytics' },
  { id: 'p-operations', kind: 'page', title: 'Operations', href: '/operations' },
  { id: 'p-load', kind: 'page', title: 'Load Management', href: '/load-management' },
  { id: 'p-settings', kind: 'page', title: 'Admin / Settings', href: '/settings' },
];

const KIND_ICON: Record<string, string> = {
  page: '📄',
  site: '📍',
  charger: '🔌',
  session: '⚡',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [entityCache, setEntityCache] = useState<SearchResult[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const getToken = useToken();

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Load entities once on first open
  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      try {
        const token = await getToken();
        const api = createApiClient(token);
        const [sites, chargers] = await Promise.all([
          api.getSites().catch(() => []),
          api.getChargers().catch(() => []),
        ]);

        const mapped: SearchResult[] = [
          ...sites.map((s: any) => ({
            id: `site-${s.id}`,
            kind: 'site' as const,
            title: s.name,
            subtitle: s.address,
            href: `/sites/${s.id}`,
          })),
          ...chargers.map((c: any) => ({
            id: `charger-${c.id}`,
            kind: 'charger' as const,
            title: c.ocppId,
            subtitle: c.site?.name ?? '',
            href: `/chargers/${c.id}`,
          })),
        ];
        setEntityCache(mapped);
        setLoaded(true);
      } catch {
        setLoaded(true);
      }
    })();
  }, [open, loaded, getToken]);

  // Filter results based on query
  useEffect(() => {
    const q = query.toLowerCase().trim();
    if (!q) {
      setResults(PAGES.slice(0, 6));
      setActiveIdx(0);
      return;
    }
    const all = [...PAGES, ...entityCache];
    const filtered = all.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.subtitle && r.subtitle.toLowerCase().includes(q)),
    );
    setResults(filtered.slice(0, 12));
    setActiveIdx(0);
  }, [query, entityCache]);

  const go = useCallback(
    (href: string) => {
      navigate(href);
      setOpen(false);
    },
    [navigate],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIdx]) {
      go(results[activeIdx].href);
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Dialog */}
      <div className="fixed inset-x-0 top-[15%] z-[101] mx-auto w-full max-w-lg px-4">
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-gray-200 px-4 dark:border-slate-700">
            <svg
              className="h-5 w-5 shrink-0 text-gray-400 dark:text-slate-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-5.2-5.2M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"
              />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search sites, chargers, pages…"
              className="h-12 flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 outline-none dark:text-white dark:placeholder-slate-500"
            />
            <kbd className="hidden text-[10px] font-medium text-gray-400 dark:text-slate-600 sm:inline-block rounded border border-gray-200 dark:border-slate-700 px-1.5 py-0.5">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <ul className="max-h-72 overflow-y-auto py-2">
            {results.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-gray-400 dark:text-slate-500">
                No results found
              </li>
            )}
            {results.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => go(r.href)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                    i === activeIdx
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
                      : 'text-gray-700 dark:text-slate-300'
                  }`}
                >
                  <span className="text-base shrink-0">{KIND_ICON[r.kind] ?? '📄'}</span>
                  <span className="flex-1 truncate">
                    <span className="font-medium">{r.title}</span>
                    {r.subtitle && (
                      <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">
                        {r.subtitle}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-slate-600">
                    {r.kind}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {/* Footer hints */}
          <div className="flex items-center gap-4 border-t border-gray-200 px-4 py-2 text-[10px] text-gray-400 dark:border-slate-700 dark:text-slate-600">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </div>
      </div>
    </>
  );
}
