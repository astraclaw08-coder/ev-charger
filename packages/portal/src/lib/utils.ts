import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function formatDuration(startedAt: string, stoppedAt: string | null | undefined): string {
  if (!stoppedAt) return 'Ongoing';
  const ms = new Date(stoppedAt).getTime() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
}

/** Format a total number of seconds into human-readable "Xd Xh Xm" or "Xh Xm" or "Xm". */
export function formatSeconds(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0m';
  const days = Math.floor(totalSeconds / 86400);
  const hrs = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hrs}h ${mins}m`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}
