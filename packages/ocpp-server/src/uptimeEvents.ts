import { prisma, type UptimeEventType } from '@ev-charger/shared';

/** Event types excluded from uptime calculation per NEVI §680.116(b)(3). */
export const EXCLUDED_EVENT_TYPES = new Set<string>([
  'SCHEDULED_MAINTENANCE',
  'UTILITY_INTERRUPTION',
  'VEHICLE_FAULT',
  'VANDALISM',
  'FORCE_MAJEURE',
]);

export async function recordUptimeEvent(
  chargerId: string,
  event: UptimeEventType,
  opts?: { connectorId?: number; reason?: string; errorCode?: string },
) {
  try {
    const last = await prisma.uptimeEvent.findFirst({
      where: { chargerId },
      orderBy: { createdAt: 'desc' },
      select: { event: true, createdAt: true },
    });

    // de-dup noisy transitions for 30s window
    if (last && last.event === event && Date.now() - last.createdAt.getTime() < 30_000) return;

    await prisma.uptimeEvent.create({
      data: {
        chargerId,
        connectorId: opts?.connectorId,
        event,
        reason: opts?.reason,
        errorCode: opts?.errorCode,
      },
    });
  } catch (err) {
    console.warn('[UptimeEvent] failed to persist event', { chargerId, event, err });
  }
}

export function toUptimeEvent(status: string): UptimeEventType {
  if (status === 'Faulted') return 'FAULTED';
  if (status === 'Unavailable') return 'OFFLINE';
  return 'ONLINE';
}
