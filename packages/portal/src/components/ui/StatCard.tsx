import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface StatCardProps {
  icon?: ReactNode;
  value: string | number;
  label: string;
  trend?: { value: number; label?: string };
  sparkline?: ReactNode;
  className?: string;
}

export default function StatCard({ icon, value, label, trend, sparkline, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 shadow-sm transition-shadow hover:shadow-md',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {icon && (
          <div className="hidden lg:flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>span]:scale-75">
            {icon}
          </div>
        )}
        <p className="text-[11px] font-medium text-gray-500 dark:text-slate-400 truncate leading-tight">{label}</p>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-[clamp(0.85rem,1.4vw,1.35rem)] font-bold text-gray-900 dark:text-slate-100 tabular-nums whitespace-nowrap leading-tight">
          {value}
        </span>
        {trend && (
          <span
            className={cn(
              'inline-flex items-center text-[10px] font-medium shrink-0',
              trend.value > 0
                ? 'text-green-600 dark:text-green-400'
                : trend.value < 0
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-gray-500 dark:text-slate-400',
            )}
          >
            {trend.value > 0 ? '↑' : trend.value < 0 ? '↓' : ''}
            {Math.abs(trend.value)}%
            {trend.label && <span className="ml-1 text-gray-400 dark:text-slate-500">{trend.label}</span>}
          </span>
        )}
      </div>
      {sparkline && <div className="mt-3">{sparkline}</div>}
    </div>
  );
}
