import type { TooltipProps } from 'recharts';
import { usePortalTheme } from '../../theme/ThemeContext';

type Formatter = (value: number, name: string) => string;

interface ChartTooltipProps extends TooltipProps<number, string> {
  formatValue?: Formatter;
}

export function useChartTheme() {
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';
  return {
    grid: isDark ? '#334155' : '#e2e8f0',
    tick: isDark ? '#94a3b8' : '#64748b',
    isDark,
  };
}

export default function ChartTooltip({ active, payload, label, formatValue }: ChartTooltipProps) {
  const { theme } = usePortalTheme();
  const isDark = theme === 'dark';

  if (!active || !payload?.length) return null;

  return (
    <div
      className={`rounded-lg border px-3 py-2 shadow-lg text-sm ${
        isDark
          ? 'border-slate-600 bg-slate-800 text-slate-100'
          : 'border-gray-200 bg-white text-gray-900'
      }`}
    >
      {label && (
        <p className={`text-xs font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
          {label}
        </p>
      )}
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
            style={{ backgroundColor: entry.color }}
          />
          <span className={`text-xs ${isDark ? 'text-slate-300' : 'text-gray-600'}`}>
            {entry.name}:
          </span>
          <span className="font-mono font-medium tabular-nums">
            {formatValue ? formatValue(entry.value as number, entry.name as string) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}
