import { prisma } from '@ev-charger/shared';

type OutboxRow = {
  id: string;
  chargerId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
};

type SampledValue = {
  value?: unknown;
  measurand?: unknown;
  unit?: unknown;
};

type MeterValueEntry = {
  timestamp?: unknown;
  sampledValue?: unknown;
};

type ParsedMeterValuesPayload = {
  connectorId: number;
  transactionId?: number;
  meterValue: MeterValueEntry[];
};

type ReadingPoint = {
  timestamp: Date;
  cumulativeWh?: number;
  maxPowerKw?: number;
};

type IntervalComputation = {
  intervalStart: Date;
  intervalEnd: Date;
  energyKwh: number;
  avgPowerKw: number;
  maxPowerKw?: number;
  dataQualityFlag?: string;
};

const POLL_INTERVAL_MS = Number(process.env.EVC_PLATFORM_POLL_INTERVAL_MS ?? 1500);
const BATCH_SIZE = Number(process.env.EVC_PLATFORM_BATCH_SIZE ?? 100);
const MAX_ATTEMPTS = Number(process.env.EVC_PLATFORM_MAX_ATTEMPTS ?? 12);
const SOURCE_VERSION = 'v1';
const PT_TIMEZONE = 'America/Los_Angeles';
const QUARTER_MINUTES = 15;
const QUARTER_MS = QUARTER_MINUTES * 60 * 1000;

function backoffMs(attempt: number): number {
  const base = 1000;
  return Math.min(300000, base * 2 ** Math.max(0, attempt));
}

async function claimBatch(limit: number): Promise<OutboxRow[]> {
  return prisma.$queryRaw<OutboxRow[]>`
    WITH next_jobs AS (
      SELECT id
      FROM "OcppEventOutbox"
      WHERE status IN ('PENDING', 'FAILED')
        AND "nextAttemptAt" <= NOW()
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OcppEventOutbox" o
    SET status = 'PROCESSING'
    FROM next_jobs
    WHERE o.id = next_jobs.id
    RETURNING o.id, o."chargerId", o."eventType", o.payload, o.attempts;
  `;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseMeterValuesPayload(payload: unknown): ParsedMeterValuesPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('MeterValues payload must be an object');
  }

  const raw = payload as { connectorId?: unknown; transactionId?: unknown; meterValue?: unknown };
  const connectorIdRaw = toFiniteNumber(raw.connectorId);
  if (connectorIdRaw === undefined || !Number.isInteger(connectorIdRaw) || connectorIdRaw <= 0) {
    throw new Error('MeterValues payload missing valid connectorId');
  }
  const connectorId: number = connectorIdRaw;

  const transactionIdRaw = toFiniteNumber(raw.transactionId);
  const transactionId = Number.isInteger(transactionIdRaw) ? transactionIdRaw : undefined;

  if (!Array.isArray(raw.meterValue) || raw.meterValue.length === 0) {
    throw new Error('MeterValues payload missing meterValue[]');
  }

  return {
    connectorId,
    transactionId,
    meterValue: raw.meterValue as MeterValueEntry[],
  };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
  }).formatToParts(date);
  const tzName = parts.find((part) => part.type === 'timeZoneName')?.value;
  if (!tzName) return 0;

  const match = tzName.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  return sign * (hours * 60 + minutes);
}

function dateTimePartsInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const num = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour'),
    minute: num('minute'),
  };
}

function zonedDateTimeToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let offset = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  let utcMillis = utcGuess - offset * 60_000;

  // One correction pass handles DST boundaries.
  const offsetAfter = getTimeZoneOffsetMinutes(new Date(utcMillis), timeZone);
  if (offsetAfter !== offset) {
    utcMillis = utcGuess - offsetAfter * 60_000;
  }

  return new Date(utcMillis);
}

function getQuarterHourIntervalUtc(date: Date): { start: Date; end: Date } {
  const local = dateTimePartsInTimeZone(date, PT_TIMEZONE);
  const flooredMinute = Math.floor(local.minute / QUARTER_MINUTES) * QUARTER_MINUTES;
  const start = zonedDateTimeToUtcDate(local.year, local.month, local.day, local.hour, flooredMinute, PT_TIMEZONE);
  const end = new Date(start.getTime() + QUARTER_MS);
  return { start, end };
}

function extractReadingPoint(entry: MeterValueEntry): ReadingPoint | null {
  const timestampString = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  if (!timestampString) return null;

  const timestamp = new Date(timestampString);
  if (Number.isNaN(timestamp.getTime())) return null;

  const sampledValues = Array.isArray(entry.sampledValue) ? (entry.sampledValue as SampledValue[]) : [];

  let cumulativeWh: number | undefined;
  let maxPowerKw: number | undefined;

  for (const sampled of sampledValues) {
    if (!sampled || typeof sampled !== 'object') continue;

    const measurand = typeof sampled.measurand === 'string' ? sampled.measurand : undefined;
    const unit = typeof sampled.unit === 'string' ? sampled.unit : undefined;
    const numericValue = toFiniteNumber(sampled.value);
    if (numericValue === undefined) continue;

    if (measurand === 'Energy.Active.Import.Register') {
      if (unit === 'Wh' || unit === undefined) {
        cumulativeWh = numericValue;
      } else if (unit === 'kWh') {
        cumulativeWh = numericValue * 1000;
      }
    }

    if (measurand === 'Power.Active.Import' || measurand === 'Power.Active.Import.Register' || measurand === 'Power.Offered') {
      const powerKw = unit === 'W' ? numericValue / 1000 : numericValue;
      if (powerKw >= 0) {
        maxPowerKw = maxPowerKw === undefined ? powerKw : Math.max(maxPowerKw, powerKw);
      }
    }
  }

  return { timestamp, cumulativeWh, maxPowerKw };
}

export function computeIntervalsFromMeterValues(entries: MeterValueEntry[]): IntervalComputation[] {
  const points = entries
    .map(extractReadingPoint)
    .filter((point): point is ReadingPoint => point !== null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const aggregate = new Map<string, IntervalComputation & { flags: Set<string> }>();

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];

    const gapMs = curr.timestamp.getTime() - prev.timestamp.getTime();
    if (gapMs <= 0) continue;

    const interval = getQuarterHourIntervalUtc(curr.timestamp);
    const key = `${interval.start.toISOString()}__${interval.end.toISOString()}`;

    const existing = aggregate.get(key) ?? {
      intervalStart: interval.start,
      intervalEnd: interval.end,
      energyKwh: 0,
      avgPowerKw: 0,
      maxPowerKw: undefined,
      dataQualityFlag: undefined,
      flags: new Set<string>(),
    };

    if (gapMs > QUARTER_MS) {
      existing.flags.add('SPARSE_GAP');
    }

    if (curr.maxPowerKw !== undefined) {
      existing.maxPowerKw = existing.maxPowerKw === undefined ? curr.maxPowerKw : Math.max(existing.maxPowerKw, curr.maxPowerKw);
    }

    if (prev.cumulativeWh === undefined || curr.cumulativeWh === undefined) {
      existing.flags.add('MISSING_ENERGY_READING');
      aggregate.set(key, existing);
      continue;
    }

    const deltaWh = curr.cumulativeWh - prev.cumulativeWh;
    if (!(deltaWh > 0)) {
      if (deltaWh < 0) {
        existing.flags.add('NEGATIVE_DELTA_SKIPPED');
      }
      aggregate.set(key, existing);
      continue;
    }

    existing.energyKwh += deltaWh / 1000;
    aggregate.set(key, existing);
  }

  return Array.from(aggregate.values())
    .map((interval) => {
      const intervalHours = (interval.intervalEnd.getTime() - interval.intervalStart.getTime()) / 3_600_000;
      const avgPowerKw = intervalHours > 0 ? interval.energyKwh / intervalHours : 0;
      return {
        intervalStart: interval.intervalStart,
        intervalEnd: interval.intervalEnd,
        energyKwh: Number(interval.energyKwh.toFixed(6)),
        avgPowerKw: Number(avgPowerKw.toFixed(6)),
        maxPowerKw: interval.maxPowerKw !== undefined ? Number(interval.maxPowerKw.toFixed(6)) : undefined,
        dataQualityFlag: interval.flags.size > 0 ? Array.from(interval.flags).sort().join(',') : undefined,
      };
    })
    .filter((interval) => interval.energyKwh > 0 || interval.maxPowerKw !== undefined)
    .sort((a, b) => a.intervalStart.getTime() - b.intervalStart.getTime());
}

async function processMeterValues(row: OutboxRow): Promise<void> {
  const parsed = parseMeterValuesPayload(row.payload);
  const intervals = computeIntervalsFromMeterValues(parsed.meterValue);
  if (intervals.length === 0) return;

  const charger = await prisma.charger.findUnique({
    where: { id: row.chargerId },
    select: { siteId: true },
  });
  if (!charger) {
    throw new Error(`Charger not found: ${row.chargerId}`);
  }

  let sessionId: string | undefined;
  if (parsed.transactionId !== undefined) {
    const session = await prisma.session.findUnique({
      where: { transactionId: parsed.transactionId },
      select: { id: true },
    });
    sessionId = session?.id;
  }

  for (const interval of intervals) {
    await prisma.rebateInterval15m.upsert({
      where: {
        chargerId_connectorId_intervalStart_intervalEnd_sourceVersion: {
          chargerId: row.chargerId,
          connectorId: parsed.connectorId,
          intervalStart: interval.intervalStart,
          intervalEnd: interval.intervalEnd,
          sourceVersion: SOURCE_VERSION,
        },
      },
      create: {
        siteId: charger.siteId,
        chargerId: row.chargerId,
        sessionId,
        connectorId: parsed.connectorId,
        intervalStart: interval.intervalStart,
        intervalEnd: interval.intervalEnd,
        intervalMinutes: QUARTER_MINUTES,
        energyKwh: interval.energyKwh,
        avgPowerKw: interval.avgPowerKw,
        maxPowerKw: interval.maxPowerKw,
        dataQualityFlag: interval.dataQualityFlag,
        sourceVersion: SOURCE_VERSION,
      },
      update: {
        siteId: charger.siteId,
        sessionId,
        energyKwh: interval.energyKwh,
        avgPowerKw: interval.avgPowerKw,
        maxPowerKw: interval.maxPowerKw,
        dataQualityFlag: interval.dataQualityFlag,
      },
    });
  }
}

async function processEvent(row: OutboxRow): Promise<void> {
  switch (row.eventType) {
    case 'MeterValues':
      await processMeterValues(row);
      return;
    case 'BootNotification':
    case 'Heartbeat':
    case 'StatusNotification':
    case 'StartTransaction':
    case 'StopTransaction':
      return;
    default:
      throw new Error(`Unsupported eventType: ${row.eventType}`);
  }
}

async function markDone(id: string): Promise<void> {
  await prisma.ocppEventOutbox.update({
    where: { id },
    data: { status: 'DONE', processedAt: new Date(), lastError: null },
  });
}

async function markFailed(id: string, attempts: number, err: unknown): Promise<void> {
  const nextAttempts = attempts + 1;
  const terminal = nextAttempts >= MAX_ATTEMPTS;
  await prisma.ocppEventOutbox.update({
    where: { id },
    data: {
      attempts: nextAttempts,
      status: 'FAILED',
      lastError: err instanceof Error ? err.message : String(err),
      nextAttemptAt: terminal ? new Date(Date.now() + 300000) : new Date(Date.now() + backoffMs(nextAttempts)),
    },
  });
}

async function tick(): Promise<void> {
  const rows = await claimBatch(BATCH_SIZE);
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      await processEvent(row);
      await markDone(row.id);
    } catch (err) {
      await markFailed(row.id, row.attempts, err);
    }
  }

  console.log(`[EVC Platform] processed batch=${rows.length}`);
}

async function main(): Promise<void> {
  console.log('[EVC Platform] worker started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    maxAttempts: MAX_ATTEMPTS,
  });

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error('[EVC Platform] tick failed', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (require.main === module) {
  void main();
}
