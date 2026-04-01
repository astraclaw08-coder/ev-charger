import { cn } from '../../lib/utils';

export type TabItem = { id: string; label: string };

interface TabBarProps {
  tabs: TabItem[];
  activeTab: string;
  onChange: (id: string) => void;
  variant?: 'pill' | 'underline';
}

export default function TabBar({ tabs, activeTab, onChange, variant = 'pill' }: TabBarProps) {
  if (variant === 'underline') {
    return (
      <div className="border-b border-gray-200 dark:border-slate-700">
        <div className="flex gap-1 -mb-px">
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onChange(tab.id)}
                className={cn(
                  'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                  active
                    ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                    : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 hover:border-gray-300 dark:hover:border-slate-500',
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1.5">
      <div className="flex flex-wrap gap-1">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-gray-100 text-gray-900 dark:bg-brand-500/20 dark:text-brand-200'
                  : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
