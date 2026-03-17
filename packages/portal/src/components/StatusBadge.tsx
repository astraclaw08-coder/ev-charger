import { cn } from '../lib/utils';

type ChargerStatus = 'ONLINE' | 'OFFLINE' | 'FAULTED' | 'DEGRADED';
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
  ONLINE: 'bg-green-100 text-green-800',
  DEGRADED: 'bg-amber-100 text-amber-800',
  OFFLINE: 'bg-gray-100 text-gray-600',
  FAULTED: 'bg-red-100 text-red-800',
};

const CONNECTOR_COLORS: Record<ConnectorStatus, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  PREPARING: 'bg-blue-100 text-blue-800',
  CHARGING: 'bg-brand-100 text-brand-700',
  SUSPENDED_EVSE: 'bg-yellow-100 text-yellow-800',
  SUSPENDED_EV: 'bg-yellow-100 text-yellow-800',
  FINISHING: 'bg-blue-100 text-blue-800',
  RESERVED: 'bg-purple-100 text-purple-800',
  UNAVAILABLE: 'bg-gray-100 text-gray-600',
  FAULTED: 'bg-red-100 text-red-800',
};

interface Props {
  status: string;
  type?: 'charger' | 'connector';
}

function normalizeChargerStatus(status: string): ChargerStatus {
  return status === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
}

export default function StatusBadge({ status, type = 'charger' }: Props) {
  const normalizedStatus = type === 'charger' ? normalizeChargerStatus(status) : status;
  const colorMap = type === 'charger' ? CHARGER_COLORS : CONNECTOR_COLORS;
  const color = (colorMap as Record<string, string>)[normalizedStatus] ?? 'bg-gray-100 text-gray-600';

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
