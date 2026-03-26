import { prisma, type ChargerStatus, type UptimeEventType } from '@ev-charger/shared';
import { isAvailable } from '../workers/uptimeMaterializer';

const HEARTBEAT_THRESHOLD_SECONDS = Number(process.env.OCPP_HEARTBEAT_THRESHOLD_SECONDS ?? 900);
const OFFLINE_GRACE_SECONDS = Number(process.env.OCPP_OFFLINE_GRACE_SECONDS ?? 120);
const OFFLINE_CONFIRM_SECONDS = Number(process.env.OCPP_OFFLINE_CONFIRM_SECONDS ?? 120);
const UPTIME_ALERT_THRESHOLD_PERCENT = Number(process.env.OCPP_UPTIME_ALERT_THRESHOLD_PERCENT ?? 95);

export type UptimeIncident = {
  event: UptimeEventType;
  reason: string | null;
  errorCode: string | null;
  connectorId: number | null;
  timestamp: string;
};

export interface DailySums {
  totalSeconds: number;
  availableSeconds: number;
  outageSeconds: number;
  excludedOutageSeconds: number;
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

  // Binary model: stale heartbeat = OFFLINE. No intermediate DEGRADED state.
  if (stale && (charger.status === 'ONLINE' || charger.status === 'DEGRADED')) {
    await prisma.charger.update({ where: { id: charger.id }, data: { status: 'OFFLINE' } });
    await prisma.uptimeEvent.create({
      data: {
        chargerId: charger.id,
        event: 'OFFLINE',
        reason: `Heartbeat stale (> ${HEARTBEAT_THRESHOLD_SECONDS + OFFLINE_GRACE_SECONDS}s)`,
      },
    });
    return { ...charger, status: 'OFFLINE' as const };
  }

  return charger;
}

// ─── UptimeDaily-based calculation (primary) ─────────────────────────────────

async function sumUptimeDaily(chargerId: string, fromDate: Date, toDate: Date): Promise<DailySums | null> {
  const rows = await prisma.uptimeDaily.findMany({
    where: {
      chargerId,
      date: { gte: fromDate, lte: toDate },
    },
  });

  if (rows.length === 0) return null;

  return (rows as DailySums[]).reduce(
    (acc: DailySums, r: DailySums) => ({
      totalSeconds: acc.totalSeconds + r.totalSeconds,
      availableSeconds: acc.availableSeconds + r.availableSeconds,
      outageSeconds: acc.outageSeconds + r.outageSeconds,
      excludedOutageSeconds: acc.excludedOutageSeconds + r.excludedOutageSeconds,
    }),
    { totalSeconds: 0, availableSeconds: 0, outageSeconds: 0, excludedOutageSeconds: 0 },
  );
}

function computePercent(sums: DailySums): number {
  if (sums.totalSeconds <= 0) return 100;
  const countedOutage = Math.max(0, sums.outageSeconds - sums.excludedOutageSeconds);
  const pct = ((sums.totalSeconds - countedOutage) / sums.totalSeconds) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
}

// ─── Legacy fallback (timeline walk) for chargers with no UptimeDaily rows ──

function toStatus(event: UptimeEventType): ChargerStatus {
  if (event === 'ONLINE' || event === 'RECOVERED') return 'ONLINE';
  if (event === 'FAULTED') return 'FAULTED';
  // DEGRADED = can't confirm online = treat as OFFLINE for uptime
  return 'OFFLINE';
}

function legacyCalcPct(
  timelineEvents: Array<{ createdAt: Date; event: string }>,
  chargerCreatedAt: Date,
  from: Date,
  now: number,
): number {
  const effectiveFrom = new Date(Math.max(from.getTime(), chargerCreatedAt.getTime()));
  const fromMs = effectiveFrom.getTime();
  const totalMs = now - fromMs;
  if (totalMs <= 0) return 100;

  let state: ChargerStatus = 'OFFLINE';
  const before = timelineEvents.filter((e) => e.createdAt.getTime() < fromMs).at(-1);
  if (before) state = toStatus(before.event as UptimeEventType);

  let upMs = 0;
  let cursor = fromMs;

  for (const e of timelineEvents) {
    const ts = e.createdAt.getTime();
    if (ts < fromMs) continue;
    if (isAvailable(state)) upMs += ts - cursor;
    cursor = ts;
    state = toStatus(e.event as UptimeEventType);
  }
  if (isAvailable(state)) upMs += now - cursor;

  return Math.max(0, Math.min(100, Math.round((upMs / totalMs) * 10000) / 100));
}

// ─── Main public API ─────────────────────────────────────────────────────────

export async function getChargerUptime(chargerId: string) {
  const charger = await ensureChargerLiveness(chargerId);
  if (!charger) return null;

  const now = Date.now();
  const nowDate = new Date(now);

  // Date boundaries for UptimeDaily queries
  const today = dayStartUTC(nowDate);
  const d1ago = new Date(today.getTime() - 1 * 86400000);
  const d7ago = new Date(today.getTime() - 6 * 86400000);
  const d30ago = new Date(today.getTime() - 29 * 86400000);

  // Try UptimeDaily first
  const [sums24h, sums7d, sums30d] = await Promise.all([
    sumUptimeDaily(chargerId, d1ago, today),
    sumUptimeDaily(chargerId, d7ago, today),
    sumUptimeDaily(chargerId, d30ago, today),
  ]);

  let uptimePercent24h: number;
  let uptimePercent7d: number;
  let uptimePercent30d: number;
  let breakdown24h: DailySums | null = sums24h;
  let breakdown7d: DailySums | null = sums7d;
  let breakdown30d: DailySums | null = sums30d;

  // Only use materialized data if it covers enough of the requested window.
  // UptimeDaily rows are per-day; require at least 1d for 24h, 5d for 7d, 20d for 30d.
  const rows24h = sums24h ? await prisma.uptimeDaily.count({ where: { chargerId, date: { gte: d1ago, lte: today } } }) : 0;
  const rows7d = sums7d ? await prisma.uptimeDaily.count({ where: { chargerId, date: { gte: d7ago, lte: today } } }) : 0;
  const rows30d = sums30d ? await prisma.uptimeDaily.count({ where: { chargerId, date: { gte: d30ago, lte: today } } }) : 0;
  const materializedCoverageOk = rows24h >= 1 && rows7d >= 5 && rows30d >= 20;

  if (materializedCoverageOk && sums24h && sums7d && sums30d) {
    // Use materialized data — sufficient coverage
    uptimePercent24h = computePercent(sums24h);
    uptimePercent7d = computePercent(sums7d);
    uptimePercent30d = computePercent(sums30d);
  } else {
    // Fallback: legacy timeline walk (before materializer has run)
    const windows = {
      h24: new Date(now - 24 * 60 * 60 * 1000),
      d7: new Date(now - 7 * 24 * 60 * 60 * 1000),
      d30: new Date(now - 30 * 24 * 60 * 60 * 1000),
    };

    const timelineEvents = await prisma.uptimeEvent.findMany({
      where: {
        chargerId,
        createdAt: { gte: windows.d30 },
        OR: [{ connectorId: null }, { connectorId: 0 }],
        NOT: { reason: 'uptime-alert-below-threshold' },
      },
      orderBy: { createdAt: 'asc' },
    });

    uptimePercent24h = legacyCalcPct(timelineEvents, charger.createdAt, windows.h24, now);
    uptimePercent7d = legacyCalcPct(timelineEvents, charger.createdAt, windows.d7, now);
    uptimePercent30d = legacyCalcPct(timelineEvents, charger.createdAt, windows.d30, now);
    breakdown24h = null;
    breakdown7d = null;
    breakdown30d = null;
  }

  // Incidents — always from UptimeEvent
  const incidentEvents = await prisma.uptimeEvent.findMany({
    where: { chargerId, createdAt: { gte: new Date(now - 30 * 86400000) } },
    orderBy: { createdAt: 'asc' },
  });

  const incidents: UptimeIncident[] = incidentEvents
    .filter((e: any) => e.event === 'OFFLINE' || e.event === 'FAULTED' || e.event === 'DEGRADED'
      || e.event === 'SCHEDULED_MAINTENANCE' || e.event === 'UTILITY_INTERRUPTION'
      || e.event === 'VEHICLE_FAULT' || e.event === 'VANDALISM' || e.event === 'FORCE_MAJEURE')
    .slice(-20)
    .map((e: any) => ({
      event: e.event,
      reason: e.reason,
      errorCode: e.errorCode,
      connectorId: e.connectorId,
      timestamp: e.createdAt.toISOString(),
    }));

  if (uptimePercent24h < UPTIME_ALERT_THRESHOLD_PERCENT) {
    console.warn(`[UptimeAlert] charger ${chargerId} below threshold: ${uptimePercent24h}% < ${UPTIME_ALERT_THRESHOLD_PERCENT}%`);
  }

  return {
    chargerId,
    currentStatus: charger.status,
    lastOnlineAt: charger.lastHeartbeat?.toISOString() ?? null,
    uptimePercent24h,
    uptimePercent7d,
    uptimePercent30d,
    // Breakdown fields (null when using legacy fallback)
    availableSeconds: breakdown30d?.availableSeconds ?? null,
    outageSeconds: breakdown30d?.outageSeconds ?? null,
    excludedOutageSeconds: breakdown30d?.excludedOutageSeconds ?? null,
    breakdown: {
      h24: breakdown24h,
      d7: breakdown7d,
      d30: breakdown30d,
    },
    incidents,
  };
}

function dayStartUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
