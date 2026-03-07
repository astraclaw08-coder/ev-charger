import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';
import { usePortalTheme } from '../theme/ThemeContext';

const NAV = [
  { label: 'Dashboard', href: '/', icon: '🏠' },
  { label: 'Sites', href: '/sites', icon: '📍' },
  { label: 'Analytics', href: '/analytics', icon: '📊' },
  { label: 'Support', href: '/support', icon: '🎧' },
  { label: 'Network Ops', href: '/network', icon: '🛠️' },
  { label: 'Settings', href: '/settings', icon: '⚙️' },
];

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M21 14.2A8.8 8.8 0 1 1 9.8 3a7.2 7.2 0 1 0 11.2 11.2Z" />
    </svg>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { theme, toggleTheme } = usePortalTheme();

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r border-gray-200 bg-white">
        <div className="flex h-14 items-center gap-2 border-b border-gray-200 px-4">
          <span className="text-xl">⚡</span>
          <span className="font-semibold text-gray-900">EV Portal</span>
        </div>

        <nav className="flex-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                item.href === '/' ? location.pathname === '/' : location.pathname.startsWith(item.href)
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
              )}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-gray-200 p-3 text-xs text-gray-400">
          OCPP 1.6J Central System
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div
          className={cn(
            'sticky top-0 z-20 border-b backdrop-blur',
            theme === 'dark' ? 'border-gray-700 bg-gray-900/95' : 'border-gray-200 bg-gray-50/95',
          )}
        >
          <div className="mx-auto flex max-w-6xl items-center justify-end px-6 py-3">
            <button
              type="button"
              onClick={toggleTheme}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1',
                theme === 'dark'
                  ? 'border-gray-600 bg-gray-800 text-gray-100 hover:bg-gray-700 hover:text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-900',
              )}
              aria-label={theme === 'dark' ? 'Dark theme active' : 'Light theme active'}
              title={theme === 'dark' ? 'Dark theme active' : 'Light theme active'}
            >
              {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
              <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
            </button>
          </div>
        </div>
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </main>
    </div>
  );
}
