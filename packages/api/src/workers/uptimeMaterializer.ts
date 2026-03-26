import { prisma, type UptimeEventType, type ChargerStatus } from '@ev-charger/shared';

/**
 * Uptime Materializer — OCA/NEVI §680.116
 *
 * Computes daily uptime counters per charger into UptimeDaily.
 * Runs periodically (every 5 min) to keep today + yesterday current.
 *
 * Availability definition (OCA v1.1 / NEVI §680.116):
 *   AVAILABLE (UP): ONLINE, RECOVERED, DEGRADED
 *     — A charger is "available" if it can accept a charge session.
 *     — DEGRADED (stale heartbeat) doesn't mean the charger can't charge.
 *   DOWN (outage): OFFLINE, FAULTED
 *     — Confirmed unreachable or hardware fault.
 *
 * Excluded outage types (per §680.116(b)(3)):
 *   SCHEDULED_MAINTENANCE, UTILITY_INTERRUPTION, VEHICLE_FAULT, VANDALISM, FORCE_MAJEURE
 *
 * Formula: µ = (totalSeconds − (outageSeconds − excludedOutageSeconds)) / totalSeconds × 100
 */

/** Excluded event types per NEVI §680.116(b)(3). */
const EXCLUDED_EVENT_TYPES: Set<string> = new Set([
  'SCHEDULED_MAINTENANCE',
  'UTILITY_INTERRUPTION',
  'VEHICLE_FAULT',
  'VANDALISM',
  'FORCE_MAJEURE',
]);

const DAY_SECONDS = 86400;

/**
 * OCA/NEVI availability: ONLINE, DEGRADED, and RECOVERED all count as "available".
 * This is the single canonical availability check — all uptime code must use this.
 */
export function isAvailable(status: ChargerStatus): boolean {
  return status === 'ONLINE' || status === 'DEGRADED';
}

function toChargerStatus(event: UptimeEventType): ChargerStatus {
  if (event === 'ONLINE' || event === 'RECOVERED') return 'ONLINE';
  if (event === 'FAULTED') return 'FAULTED';
  if (event === 'DEGRADED') return 'DEGRADED';
  return 'OFFLINE';
}

function isExcludedEvent(event: UptimeEventType): boolean {
  return EXCLUDED_EVENT_TYPES.has(event);
}

interface DayCounters {
  totalSeconds: number;
  availableSeconds: number;
  outageSeconds: number;
  excludedOutageSeconds: number;
}

/**
 * Compute uptime counters for a single charger for a single day.
 */
async function computeDayCounters(
  chargerId: string,
  chargerCreatedAt: Date,
  dayStart: Date,
  dayEnd: Date, // exclusive — either start of next day or "now" for today
): Promise<DayCounters> {
  const createdAtMs = chargerCreatedAt.getTime();
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();

  // Clamp to charger provisioning date
  const effectiveStartMs = Math.max(dayStartMs, createdAtMs);
  if (effectiveStartMs >= dayEndMs) {
    return { totalSeconds: 0, availableSeconds: 0, outageSeconds: 0, excludedOutageSeconds: 0 };
  }

  const totalSeconds = Math.floor((dayEndMs - effectiveStartMs) / 1000);

  // Get charger-level events for this day (exclude connector-specific and alert markers)
  const events = await prisma.uptimeEvent.findMany({
    where: {
      chargerId,
      createdAt: { gte: dayStart, lt: dayEnd },
      OR: [{ connectorId: null }, { connectorId: 0 }],
      NOT: { reason: 'uptime-alert-below-threshold' },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Find initial state: last event before this day's effective start
  const beforeEvent = await prisma.uptimeEvent.findFirst({
    where: {
      chargerId,
      createdAt: { lt: new Date(effectiveStartMs) },
      OR: [{ connectorId: null }, { connectorId: 0 }],
      NOT: { reason: 'uptime-alert-below-threshold' },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Default to OFFLINE if no prior event
  let currentStatus: ChargerStatus = beforeEvent
    ? toChargerStatus(beforeEvent.event as UptimeEventType)
    : 'OFFLINE';
  let currentEventIsExcluded = beforeEvent
    ? isExcludedEvent(beforeEvent.event as UptimeEventType)
    : false;

  let availableSeconds = 0;
  let outageSeconds = 0;
  let excludedOutageSeconds = 0;
  let cursor = effectiveStartMs;

  for (const e of events) {
    const ts = Math.max(e.createdAt.getTime(), effectiveStartMs);
    if (ts > cursor) {
      const segmentSec = Math.floor((ts - cursor) / 1000);
      if (isAvailable(currentStatus)) {
        availableSeconds += segmentSec;
      } else {
        outageSeconds += segmentSec;
        if (currentEventIsExcluded) {
          excludedOutageSeconds += segmentSec;
        }
      }
    }
    cursor = ts;
    currentStatus = toChargerStatus(e.event as UptimeEventType);
    currentEventIsExcluded = isExcludedEvent(e.event as UptimeEventType);
  }

  // Final segment from last event to end of day
  if (dayEndMs > cursor) {
    const segmentSec = Math.floor((dayEndMs - cursor) / 1000);
    if (isAvailable(currentStatus)) {
      availableSeconds += segmentSec;
    } else {
      outageSeconds += segmentSec;
      if (currentEventIsExcluded) {
        excludedOutageSeconds += segmentSec;
      }
    }
  }

  return { totalSeconds, availableSeconds, outageSeconds, excludedOutageSeconds };
}

function dayStartUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_SECONDS * 1000);
}

function computePercent(counters: DayCounters): number {
  if (counters.totalSeconds <= 0) return 100;
  const countedOutage = Math.max(0, counters.outageSeconds - counters.excludedOutageSeconds);
  const pct = ((counters.totalSeconds - countedOutage) / counters.totalSeconds) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 100) / 100));
}

/**
 * Materialize uptime for all chargers for today and yesterday.
 * Yesterday is re-computed in case late events arrived.
 */
export async function materializeUptime(): Promise<void> {
  const now = new Date();
  const todayStart = dayStartUTC(now);
  const yesterdayStart = addDays(todayStart, -1);

  const chargers = await prisma.charger.findMany({
    select: { id: true, createdAt: true },
  });

  for (const charger of chargers) {
    try {
      // Yesterday (full day, finalized)
      const yesterdayEnd = todayStart;
      const yCounters = await computeDayCounters(charger.id, charger.createdAt, yesterdayStart, yesterdayEnd);
      if (yCounters.totalSeconds > 0) {
        await prisma.uptimeDaily.upsert({
          where: { chargerId_date: { chargerId: charger.id, date: yesterdayStart } },
          create: {
            chargerId: charger.id,
            date: yesterdayStart,
            ...yCounters,
            uptimePercent: computePercent(yCounters),
          },
          update: {
            ...yCounters,
            uptimePercent: computePercent(yCounters),
          },
        });
      }

      // Today (partial day, in-progress)
      const tCounters = await computeDayCounters(charger.id, charger.createdAt, todayStart, now);
      if (tCounters.totalSeconds > 0) {
        await prisma.uptimeDaily.upsert({
          where: { chargerId_date: { chargerId: charger.id, date: todayStart } },
          create: {
            chargerId: charger.id,
            date: todayStart,
            ...tCounters,
            uptimePercent: computePercent(tCounters),
          },
          update: {
            ...tCounters,
            uptimePercent: computePercent(tCounters),
          },
        });
      }
    } catch (err) {
      console.error(`[UptimeMaterializer] Failed for charger ${charger.id}:`, err);
    }
  }
}

/**
 * Backfill UptimeDaily for a charger over a date range.
 */
export async function backfillUptimeDaily(
  chargerId: string,
  fromDate: Date,
  toDate: Date,
): Promise<void> {
  const charger = await prisma.charger.findUnique({
    where: { id: chargerId },
    select: { id: true, createdAt: true },
  });
  if (!charger) throw new Error(`Charger ${chargerId} not found`);

  let cursor = dayStartUTC(fromDate);
  const end = dayStartUTC(toDate);

  while (cursor <= end) {
    const dayEnd = addDays(cursor, 1);
    const now = new Date();
    const effectiveEnd = dayEnd > now ? now : dayEnd;

    const counters = await computeDayCounters(charger.id, charger.createdAt, cursor, effectiveEnd);
    if (counters.totalSeconds > 0) {
      await prisma.uptimeDaily.upsert({
        where: { chargerId_date: { chargerId: charger.id, date: cursor } },
        create: {
          chargerId: charger.id,
          date: cursor,
          ...counters,
          uptimePercent: computePercent(counters),
        },
        update: {
          ...counters,
          uptimePercent: computePercent(counters),
        },
      });
    }

    cursor = dayEnd;
  }
}
