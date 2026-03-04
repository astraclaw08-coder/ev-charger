import { prisma, type ChargerStatus, type UptimeEventType } from '@ev-charger/shared';

const HEARTBEAT_THRESHOLD_SECONDS = Number(process.env.OCPP_HEARTBEAT_THRESHOLD_SECONDS ?? 90);
const OFFLINE_GRACE_SECONDS = Number(process.env.OCPP_OFFLINE_GRACE_SECONDS ?? 300);
const UPTIME_ALERT_THRESHOLD_PERCENT = Number(process.env.OCPP_UPTIME_ALERT_THRESHOLD_PERCENT ?? 95);

export type UptimeIncident = {
  event: UptimeEventType;
  reason: string | null;
  errorCode: string | null;
  connectorId: number | null;
  timestamp: string;
};

function isUp(status: ChargerStatus): boolean {
  return status === 'ONLINE';
}

export async function ensureChargerLiveness(chargerId: string) {
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, status: true, lastHeartbeat: true },
  });
  if (!charger) return null;

  const now = Date.now();
  const lastHbMs = charger.lastHeartbeat?.getTime() ?? 0;
  const stale = !lastHbMs || now - lastHbMs > (HEARTBEAT_THRESHOLD_SECONDS + OFFLINE_GRACE_SECONDS) * 1000;

  if (stale && charger.status === 'ONLINE') {
    await prisma.charger.update({ where: { id: charger.id }, data: { status: 'DEGRADED' } });
    await prisma.uptimeEvent.create({
      data: {
        chargerId: charger.id,
        event: 'DEGRADED',
        reason: `No heartbeat for > ${HEARTBEAT_THRESHOLD_SECONDS + OFFLINE_GRACE_SECONDS}s`,
      },
    });
    return { ...charger, status: 'DEGRADED' as const };
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

  const allEvents = await prisma.uptimeEvent.findMany({
    where: { chargerId, createdAt: { gte: windows.d30 } },
    orderBy: { createdAt: 'asc' },
  });

  const incidents: UptimeIncident[] = allEvents
    .filter((e) => e.event === 'OFFLINE' || e.event === 'FAULTED' || e.event === 'DEGRADED')
    .slice(-20)
    .map((e) => ({
      event: e.event,
      reason: e.reason,
      errorCode: e.errorCode,
      connectorId: e.connectorId,
      timestamp: e.createdAt.toISOString(),
    }));

  const calcPct = (from: Date) => {
    const totalMs = now - from.getTime();
    if (totalMs <= 0) return 100;

    // Find latest status before window starts, then fold transitions
    let state: ChargerStatus = charger.status;
    const before = allEvents.filter((e) => e.createdAt < from).at(-1);
    if (before) {
      state = before.event === 'ONLINE' || before.event === 'RECOVERED'
        ? 'ONLINE'
        : before.event === 'FAULTED'
          ? 'FAULTED'
          : before.event === 'DEGRADED'
            ? 'DEGRADED'
            : 'OFFLINE';
    }

    let upMs = 0;
    let cursor = from.getTime();

    for (const e of allEvents) {
      const ts = e.createdAt.getTime();
      if (ts < from.getTime()) continue;
      if (isUp(state)) upMs += ts - cursor;
      cursor = ts;

      state = e.event === 'ONLINE' || e.event === 'RECOVERED'
        ? 'ONLINE'
        : e.event === 'FAULTED'
          ? 'FAULTED'
          : e.event === 'DEGRADED'
            ? 'DEGRADED'
            : 'OFFLINE';
    }

    if (isUp(state)) upMs += now - cursor;
    return Math.max(0, Math.min(100, Math.round((upMs / totalMs) * 10000) / 100));
  };

  const uptimePercent24h = calcPct(windows.h24);
  const uptimePercent7d = calcPct(windows.d7);
  const uptimePercent30d = calcPct(windows.d30);

  if (uptimePercent24h < UPTIME_ALERT_THRESHOLD_PERCENT) {
    const lastAlert = await prisma.uptimeEvent.findFirst({
      where: { chargerId, event: 'DEGRADED', reason: 'uptime-alert-below-threshold' },
      orderBy: { createdAt: 'desc' },
    });
    if (!lastAlert || Date.now() - lastAlert.createdAt.getTime() > 60 * 60 * 1000) {
      await prisma.uptimeEvent.create({
        data: {
          chargerId,
          event: 'DEGRADED',
          reason: 'uptime-alert-below-threshold',
          errorCode: `24h=${uptimePercent24h}%`,
        },
      });
      console.warn(`[UptimeAlert] charger ${chargerId} below threshold: ${uptimePercent24h}% < ${UPTIME_ALERT_THRESHOLD_PERCENT}%`);
    }
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
