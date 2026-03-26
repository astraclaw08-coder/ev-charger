import { useState } from 'react';
import CustomerSupport from './CustomerSupport';
import NetworkOps from './NetworkOps';
import Notifications from './Notifications';
import { cn } from '../lib/utils';

type OpsTab = 'incidents' | 'support' | 'notifications';

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg px-3 py-2 text-sm font-medium transition',
        active
          ? 'bg-gray-100 text-gray-900 dark:bg-brand-500/20 dark:text-brand-200'
          : 'bg-white dark:bg-slate-900 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100',
      )}
    >
      {label}
    </button>
  );
}

export default function Operations() {
  const [tab, setTab] = useState<OpsTab>('incidents');

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <a href="/overview" className="hover:text-gray-700 dark:hover:text-slate-200 dark:text-slate-300">Overview</a>
          <span>/</span>
          <span className="text-gray-900 dark:text-slate-100">Operations</span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-slate-100">Operations</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          Incident response, support workflows, and proactive notification operations.
        </p>
      </div>

      <div className="rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2">
        <div className="flex flex-wrap gap-2">
          <TabButton label="Live Incidents" active={tab === 'incidents'} onClick={() => setTab('incidents')} />
          <TabButton label="Support Queue" active={tab === 'support'} onClick={() => setTab('support')} />
          <TabButton label="Notifications" active={tab === 'notifications'} onClick={() => setTab('notifications')} />
        </div>
      </div>

      {tab === 'incidents' && <NetworkOps />}
      {tab === 'support' && <CustomerSupport />}
      {tab === 'notifications' && <Notifications />}
    </div>
  );
}
