import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';
import BrandMark from './BrandMark';

type IconProps = { className?: string };

const ICON_STROKE = 2;

function DashboardIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5 12 3l9 7.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9.5V21h12V9.5" />
    </svg>
  );
}

function SitesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s6-4.5 6-10a6 6 0 1 0-12 0c0 5.5 6 10 6 10Z" />
      <circle cx="12" cy="11" r="2.2" />
    </svg>
  );
}

function AnalyticsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 20V6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 20v-8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 20v-4" />
    </svg>
  );
}

function OperationsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3 4.5 6v5.5c0 4.1 2.7 7.9 7.5 9.5 4.8-1.6 7.5-5.4 7.5-9.5V6L12 3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m9 12 2 2 4-4" />
    </svg>
  );
}

function SessionsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

function ChargersIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 5.5A2.5 2.5 0 0 1 9.5 3h3A2.5 2.5 0 0 1 15 5.5V7h1a2 2 0 0 1 2 2v3.2a2 2 0 0 1-.6 1.4l-1.4 1.4V19a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2V5.5Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6h2M9.5 11.5h3M16 9h2v4h-2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 13l1.5 1.5V17" />
      <circle cx="11" cy="17.25" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LoadManagementIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="1.8" />
      <circle cx="14" cy="12" r="1.8" />
      <circle cx="11" cy="18" r="1.8" />
    </svg>
  );
}

function SettingsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.96 6.04l-1.56 1.56M7.6 16.4l-1.56 1.56M17.96 17.96 16.4 16.4M7.6 7.6 6.04 6.04" />
      <circle cx="12" cy="12" r="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
    </svg>
  );
}

const NAV = [
  { label: 'Overview', href: '/overview', Icon: DashboardIcon },
  { label: 'Operations', href: '/operations', Icon: OperationsIcon },
  { label: 'Sites', href: '/sites', Icon: SitesIcon },
  { label: 'Chargers', href: '/chargers', Icon: ChargersIcon },
  { label: 'Sessions', href: '/sessions', Icon: SessionsIcon },
  { label: 'Analytics', href: '/analytics', Icon: AnalyticsIcon },
  { label: 'Load Management', href: '/load-management', Icon: LoadManagementIcon },
  { label: 'Admin', href: '/settings', Icon: SettingsIcon },
];

const portalVersion = import.meta.env.VITE_APP_VERSION ?? 'dev-local';

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-slate-950">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r border-slate-700 bg-slate-900 dark:border-slate-800 dark:bg-slate-950/95">
        <div className="flex h-14 items-center px-4">
          <BrandMark className="w-[140px]" />
        </div>

        <nav className="flex-1 p-3">
          {NAV.map((item) => {
            const active = item.href === '/overview'
              ? location.pathname === '/overview' || location.pathname === '/'
              : location.pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950',
                  active
                    ? 'bg-slate-700 text-white shadow-sm dark:bg-slate-700 dark:text-white'
                    : 'text-slate-300 dark:text-slate-400',
                )}
              >
                <item.Icon
                  className={cn(
                    'h-[19px] w-[19px] shrink-0 transition-all',
                    active
                      ? 'text-white dark:text-white'
                      : 'text-slate-400 dark:text-slate-500',
                  )}
                />
                <span className={active ? 'text-white' : undefined}>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-700 p-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-500">
          <div>OCPP 1.6J Central System</div>
          <div className="mt-1">Version {portalVersion}</div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-50 dark:bg-slate-950">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </main>
    </div>
  );
}
