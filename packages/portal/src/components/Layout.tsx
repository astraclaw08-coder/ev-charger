import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';

type IconProps = { className?: string };

function DashboardIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5 12 3l9 7.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9.5V21h12V9.5" />
    </svg>
  );
}

function SitesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s6-4.5 6-10a6 6 0 1 0-12 0c0 5.5 6 10 6 10Z" />
      <circle cx="12" cy="11" r="2.2" />
    </svg>
  );
}

function AnalyticsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 20V6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 20v-8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 20v-4" />
    </svg>
  );
}

function SupportIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 0 1 16 0" />
      <rect x="3" y="12" width="4" height="6" rx="1.5" />
      <rect x="17" y="12" width="4" height="6" rx="1.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 20v1" />
    </svg>
  );
}

function ToolsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.5 4.5a4 4 0 0 0 4.9 4.9l-7.1 7.1a2 2 0 1 1-2.8-2.8l7.1-7.1a4 4 0 0 0-2.1-2.1Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 19-2 2" />
    </svg>
  );
}

function SettingsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.5A3.5 3.5 0 1 1 8.5 12 3.5 3.5 0 0 1 12 8.5Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a7.7 7.7 0 0 0 .1-1 7.7 7.7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.7-1L13.9 4h-3.8L9.8 7a8 8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0-.1 1 7.7 7.7 0 0 0 .1 1l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.3 3h3.8l.3-3a8 8 0 0 0 1.7-1l2.4 1 2-3.4Z" />
    </svg>
  );
}

const NAV = [
  { label: 'Dashboard', href: '/', Icon: DashboardIcon },
  { label: 'Sites', href: '/sites', Icon: SitesIcon },
  { label: 'Analytics', href: '/analytics', Icon: AnalyticsIcon },
  { label: 'Support', href: '/support', Icon: SupportIcon },
  { label: 'Network Ops', href: '/network', Icon: ToolsIcon },
  { label: 'Settings', href: '/settings', Icon: SettingsIcon },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r border-gray-200 bg-white">
        <div className="flex h-14 items-center gap-2 border-b border-gray-200 px-4">
          <span className="text-xl">⚡</span>
          <span className="font-semibold text-gray-900">EV Portal</span>
        </div>

        <nav className="flex-1 p-3">
          {NAV.map((item) => {
            const active = item.href === '/' ? location.pathname === '/' : location.pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                )}
              >
                <item.Icon
                  className={cn(
                    'h-[18px] w-[18px] shrink-0 transition-colors',
                    active ? 'text-brand-700' : 'text-gray-500 group-hover:text-gray-900',
                  )}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-gray-200 p-3 text-xs text-gray-400">
          OCPP 1.6J Central System
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </main>
    </div>
  );
}
