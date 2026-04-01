import { cn } from '../lib/utils';

type ChargerStatus = 'ONLINE' | 'OFFLINE' | 'FAULTED';
type ConnectorStatus =
  | 'AVAILABLE'
  | 'PREPARING'
  | 'CHARGING'
  | 'SUSPENDED_EVSE'
  | 'SUSPENDED_EV'
  | 'FINISHING'
  | 'RESERVED'
  | 'UNAVAILABLE'
  | 'FAULTED';

const CHARGER_COLORS: Record<ChargerStatus, string> = {
  ONLINE: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400',
  OFFLINE: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-400',
  FAULTED: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-400',
};

const CONNECTOR_COLORS: Record<ConnectorStatus, string> = {
  AVAILABLE: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400',
  PREPARING: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-400',
  CHARGING: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-400',
  SUSPENDED_EVSE: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-400',
  SUSPENDED_EV: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-400',
  FINISHING: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-400',
  RESERVED: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-400',
  UNAVAILABLE: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-400',
  FAULTED: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-400',
};

interface Props {
  status: string;
  type?: 'charger' | 'connector';
}

function normalizeChargerStatus(status: string): ChargerStatus {
  return status === 'ONLINE' ? 'ONLINE' : status === 'FAULTED' ? 'FAULTED' : 'OFFLINE';
}

export default function StatusBadge({ status, type = 'charger' }: Props) {
  const normalizedStatus = type === 'charger' ? normalizeChargerStatus(status) : status;
  const colorMap = type === 'charger' ? CHARGER_COLORS : CONNECTOR_COLORS;
  const color = (colorMap as Record<string, string>)[normalizedStatus] ?? 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-400';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        color,
      )}
    >
      {normalizedStatus}
    </span>
  );
}
