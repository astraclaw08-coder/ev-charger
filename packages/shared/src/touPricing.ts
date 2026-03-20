export type TouWindow = {
  day: number;
  start: string;
  end: string;
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
};

export type ResolvedTouRate = {
  source: 'flat' | 'tou';
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
  window: TouWindow | null;
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60 * 1000;
const WEEKDAY_TO_NUM: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone?: string | null): Intl.DateTimeFormat | null {
  if (!timeZone) return null;
  const key = timeZone.trim();
  if (!key) return null;
  if (dtfCache.has(key)) return dtfCache.get(key)!;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    dtfCache.set(key, fmt);
    return fmt;
  } catch {
    return null;
  }
}

function localDayMinute(at: Date, timeZone?: string | null): { day: number; minuteOfDay: number } {
  const fmt = getFormatter(timeZone);
  if (!fmt) {
    return { day: at.getUTCDay(), minuteOfDay: at.getUTCHours() * 60 + at.getUTCMinutes() };
  }
  const parts = fmt.formatToParts(at);
  const wk = parts.find((p) => p.type === 'weekday')?.value?.slice(0, 3).toLowerCase() ?? '';
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const day = WEEKDAY_TO_NUM[wk] ?? at.getUTCDay();
  const minuteOfDay = Math.max(0, Math.min(1439, hh * 60 + mm));
  return { day, minuteOfDay };
}

function hhmmToMinuteOfDay(hhmm: string): number | null {
  const match = HHMM_RE.exec(hhmm);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function normalizeTouWindows(raw: unknown): TouWindow[] {
  if (!Array.isArray(raw)) return [];
  const rows: TouWindow[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Record<string, unknown>;
    const day = Number(candidate.day);
    const start = String(candidate.start ?? '');
    const end = String(candidate.end ?? '');
    const pricePerKwhUsd = Number(candidate.pricePerKwhUsd);
    const idleFeePerMinUsd = Number(candidate.idleFeePerMinUsd);
    const startMinute = hhmmToMinuteOfDay(start);
    const endMinute = hhmmToMinuteOfDay(end);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (startMinute == null || endMinute == null || endMinute <= startMinute) continue;
    if (!Number.isFinite(pricePerKwhUsd) || pricePerKwhUsd < 0) continue;
    if (!Number.isFinite(idleFeePerMinUsd) || idleFeePerMinUsd < 0) continue;
    rows.push({ day, start, end, pricePerKwhUsd, idleFeePerMinUsd });
  }
  rows.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return rows;
}

export function resolveTouRateAt(input: {
  at: Date | string | number;
  pricingMode?: string | null;
  defaultPricePerKwhUsd?: number | null;
  defaultIdleFeePerMinUsd?: number | null;
  touWindows?: unknown;
  timeZone?: string | null;
}): ResolvedTouRate {
  const defaultPricePerKwhUsd = Math.max(0, Number(input.defaultPricePerKwhUsd ?? 0) || 0);
  const defaultIdleFeePerMinUsd = Math.max(0, Number(input.defaultIdleFeePerMinUsd ?? 0) || 0);
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime()) || input.pricingMode !== 'tou') {
    return {
      source: 'flat',
      pricePerKwhUsd: defaultPricePerKwhUsd,
      idleFeePerMinUsd: defaultIdleFeePerMinUsd,
      window: null,
    };
  }

  const { day, minuteOfDay } = localDayMinute(at, input.timeZone);
  const windows = normalizeTouWindows(input.touWindows);
  const matched = windows.find((w) => {
    if (w.day !== day) return false;
    const startMinute = hhmmToMinuteOfDay(w.start);
    const endMinute = hhmmToMinuteOfDay(w.end);
    if (startMinute == null || endMinute == null) return false;
    return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }) ?? null;

  if (!matched) {
    return {
      source: 'flat',
      pricePerKwhUsd: defaultPricePerKwhUsd,
      idleFeePerMinUsd: defaultIdleFeePerMinUsd,
      window: null,
    };
  }

  return {
    source: 'tou',
    pricePerKwhUsd: matched.pricePerKwhUsd,
    idleFeePerMinUsd: matched.idleFeePerMinUsd,
    window: matched,
  };
}

export type TouDurationSegment = {
  startedAt: string;
  endedAt: string;
  minutes: number;
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
  source: 'flat' | 'tou';
};

export function splitTouDuration(input: {
  startedAt: Date | string;
  stoppedAt: Date | string;
  pricingMode?: string | null;
  defaultPricePerKwhUsd?: number | null;
  defaultIdleFeePerMinUsd?: number | null;
  touWindows?: unknown;
  timeZone?: string | null;
}): TouDurationSegment[] {
  const start = new Date(input.startedAt);
  const stop = new Date(input.stoppedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime()) || stop <= start) return [];

  const segments: TouDurationSegment[] = [];
  let cursorMs = start.getTime();
  const stopMs = stop.getTime();

  while (cursorMs < stopMs) {
    const currentRate = resolveTouRateAt({
      at: new Date(cursorMs),
      pricingMode: input.pricingMode,
      defaultPricePerKwhUsd: input.defaultPricePerKwhUsd,
      defaultIdleFeePerMinUsd: input.defaultIdleFeePerMinUsd,
      touWindows: input.touWindows,
      timeZone: input.timeZone,
    });

    let endMs = Math.min(stopMs, cursorMs + MINUTE_MS);
    while (endMs < stopMs) {
      const probeRate = resolveTouRateAt({
        at: new Date(endMs),
        pricingMode: input.pricingMode,
        defaultPricePerKwhUsd: input.defaultPricePerKwhUsd,
        defaultIdleFeePerMinUsd: input.defaultIdleFeePerMinUsd,
        touWindows: input.touWindows,
        timeZone: input.timeZone,
      });
      if (
        probeRate.source !== currentRate.source
        || probeRate.pricePerKwhUsd !== currentRate.pricePerKwhUsd
        || probeRate.idleFeePerMinUsd !== currentRate.idleFeePerMinUsd
      ) {
        break;
      }
      endMs = Math.min(stopMs, endMs + MINUTE_MS);
    }

    const minutes = (endMs - cursorMs) / MINUTE_MS;
    if (minutes > 0) {
      segments.push({
        startedAt: new Date(cursorMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        minutes: Number(minutes.toFixed(6)),
        pricePerKwhUsd: currentRate.pricePerKwhUsd,
        idleFeePerMinUsd: currentRate.idleFeePerMinUsd,
        source: currentRate.source,
      });
    }

    cursorMs = endMs;
  }

  return segments;
}
