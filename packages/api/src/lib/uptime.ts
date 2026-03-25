import { prisma, type ChargerStatus, type UptimeEventType } from '@ev-charger/shared';

const HEARTBEAT_THRESHOLD_SECONDS = Number(process.env.OCPP_HEARTBEAT_THRESHOLD_SECONDS ?? 900);
const OFFLINE_GRACE_SECONDS = Number(process.env.OCPP_OFFLINE_GRACE_SECONDS ?? 120);
const OFFLINE_CONFIRM_SECONDS = Number(process.env.OCPP_OFFLINE_CONFIRM_SECONDS ?? 120);
const UPTIME_ALERT_THRESHOLD_PERCENT = Number(process.env.OCPP_UPTIME_ALERT_THRESHOLD_PERCENT ?? 95);
const CONNECTOR_FAULT_NOISE_MS = 1000;

export type UptimeIncident = {
  event: UptimeEventType;
  reason: string | null;
  errorCode: string | null;
  connectorId: number | null;
  timestamp: string;
};

/**
 * OCA v1.1 uptime: only ONLINE counts as "available".
 * DEGRADED (stale heartbeat, reachable but uncertain) is NOT counted as up.
 */
function isUp(status: ChargerStatus): boolean {
  return status === 'ONLINE';
}

export async function ensureChargerLiveness(chargerId: string) {
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, status: true, lastHeartbeat: true, createdAt: true },
  });
  if (!charger) return null;

  const now = Date.now();
  const lastHbMs = charger.lastHeartbeat?.getTime() ?? 0;
  const staleAfterMs = (HEARTBEAT_THRESHOLD_SECONDS + OFFLINE_GRACE_SECONDS) * 1000;
  const offlineAfterMs = (HEARTBEAT_THRESHOLD_SECONDS + OFFLINE_GRACE_SECONDS + OFFLINE_CONFIRM_SECONDS) * 1000;
  const ageMs = !lastHbMs ? Number.POSITIVE_INFINITY : now - lastHbMs;
  const stale = ageMs > staleAfterMs;
  const offlineEligible = ageMs > offlineAfterMs;

  if (stale && charger.status === 'ONLINE') {
    await prisma.charger.update({ where: { id: charger.id }, data: { status: 'DEGRADED' } });
    await prisma.uptimeEvent.create({
      data: {
        chargerId: charger.id,
        event: 'DEGRADED',
        reason: `Heartbeat stale (> ${HEARTBEAT_THRESHOLD_SECONDS + OFFLINE_GRACE_SECONDS}s); awaiting offline confirmation`,
      },
    });
    return { ...charger, status: 'DEGRADED' as const };
  }

  if (offlineEligible && charger.status === 'DEGRADED') {
    const recentDisconnectSignal = await prisma.uptimeEvent.findFirst({
      where: {
        chargerId: charger.id,
        event: 'DEGRADED',
        reason: { contains: 'disconnected' },
        createdAt: { gte: new Date(now - offlineAfterMs - 5 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentDisconnectSignal) {
      await prisma.charger.update({ where: { id: charger.id }, data: { status: 'OFFLINE' } });
      await prisma.uptimeEvent.create({
        data: {
          chargerId: charger.id,
          event: 'OFFLINE',
          reason: `Confirmed unreachable after disconnect + stale heartbeat (> ${HEARTBEAT_THRESHOLD_SECONDS + OFFLINE_GRACE_SECONDS + OFFLINE_CONFIRM_SECONDS}s)`,
        },
      });
      return { ...charger, status: 'OFFLINE' as const };
    }
  }

  return charger;
}

export async function getChargerUptime(chargerId: string) {
  const charger = await ensureChargerLiveness(chargerId);
  if (!charger) return null;

  const now = Date.now();
  const windows = {
    h24: new Date(now - 24 * 60 * 60 * 1000),
    d7: new Date(now - 7 * 24 * 60 * 60 * 1000),
    d30: new Date(now - 30 * 24 * 60 * 60 * 1000),
  };

  // Timeline events for uptime % calculation:
  // - include charger-level transitions only (connectorId null/0)
  // - exclude synthetic alert marker events so they don't feed back into downtime math
  const timelineEvents = await prisma.uptimeEvent.findMany({
    where: {
      chargerId,
      createdAt: { gte: windows.d30 },
      OR: [{ connectorId: null }, { connectorId: 0 }],
      NOT: { reason: 'uptime-alert-below-threshold' },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Incidents panel can still include connector-level issues for operational visibility.
  const incidentEvents = await prisma.uptimeEvent.findMany({
    where: { chargerId, createdAt: { gte: windows.d30 } },
    orderBy: { createdAt: 'asc' },
  });

  const incidents: UptimeIncident[] = incidentEvents
    .filter((e: any) => e.event === 'OFFLINE' || e.event === 'FAULTED' || e.event === 'DEGRADED')
    .slice(-20)
    .map((e: any) => ({
      event: e.event,
      reason: e.reason,
      errorCode: e.errorCode,
      connectorId: e.connectorId,
      timestamp: e.createdAt.toISOString(),
    }));

  const toStatus = (event: UptimeEventType): ChargerStatus => (
    event === 'ONLINE' || event === 'RECOVERED'
      ? 'ONLINE'
      : event === 'FAULTED'
        ? 'FAULTED'
        : event === 'DEGRADED'
          ? 'DEGRADED'
          : 'OFFLINE'
  );

  const mergeIntervals = (intervals: Array<[number, number]>): Array<[number, number]> => {
    if (!intervals.length) return [];
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      const last = merged[merged.length - 1];
      if (s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged;
  };

  const calcPct = (from: Date) => {
    // Clamp window start to charger provisioning date — don't count time
    // before the charger existed as either up or down (OCA v1.1).
    const effectiveFrom = new Date(Math.max(from.getTime(), charger.createdAt.getTime()));
    const fromMs = effectiveFrom.getTime();
    const totalMs = now - fromMs;
    if (totalMs <= 0) return 100;

    // Default to OFFLINE when no prior event exists before window start.
    // Previously fell back to charger.status (current), which inflated uptime
    // for chargers with no history before the window.
    let state: ChargerStatus = 'OFFLINE';
    const before = timelineEvents.filter((e: any) => e.createdAt < effectiveFrom).at(-1);
    if (before) state = toStatus(before.event as UptimeEventType);

    let cursor = fromMs;
    const chargerDownIntervals: Array<[number, number]> = [];

    for (const e of timelineEvents) {
      const ts = e.createdAt.getTime();
      if (ts < fromMs) continue;
      if (!isUp(state) && ts > cursor) chargerDownIntervals.push([cursor, ts]);
      cursor = ts;
      state = toStatus(e.event as UptimeEventType);
    }
    if (!isUp(state) && now > cursor) chargerDownIntervals.push([cursor, now]);

    // Ignore sub-second down flaps as noise (fault flip <=1s).
    const stableDown = chargerDownIntervals.filter(([s, e]) => (e - s) > CONNECTOR_FAULT_NOISE_MS);

    // Merge to avoid double-counting overlaps.
    const allDown = mergeIntervals(stableDown);
    const downMs = allDown.reduce((sum, [s, e]) => sum + Math.max(0, e - s), 0);
    const upMs = Math.max(0, totalMs - downMs);

    return Math.max(0, Math.min(100, Math.round((upMs / totalMs) * 10000) / 100));
  };

  const uptimePercent24h = calcPct(windows.h24);
  const uptimePercent7d = calcPct(windows.d7);
  const uptimePercent30d = calcPct(windows.d30);

  if (uptimePercent24h < UPTIME_ALERT_THRESHOLD_PERCENT) {
    // Keep alerting side-effect free for uptime timeline math.
    console.warn(`[UptimeAlert] charger ${chargerId} below threshold: ${uptimePercent24h}% < ${UPTIME_ALERT_THRESHOLD_PERCENT}%`);
  }

  return {
    chargerId,
    currentStatus: charger.status,
    lastOnlineAt: charger.lastHeartbeat?.toISOString() ?? null,
    uptimePercent24h,
    uptimePercent7d,
    uptimePercent30d,
    incidents,
  };
}
