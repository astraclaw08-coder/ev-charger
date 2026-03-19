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
const DAY_MS = 24 * 60 * MINUTE_MS;

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

  const day = at.getUTCDay();
  const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
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
}): TouDurationSegment[] {
  const start = new Date(input.startedAt);
  const stop = new Date(input.stoppedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime()) || stop <= start) return [];

  const windows = normalizeTouWindows(input.touWindows);
  const boundaries = new Set<number>([start.getTime(), stop.getTime()]);
  const firstDayMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const lastDayMs = Date.UTC(stop.getUTCFullYear(), stop.getUTCMonth(), stop.getUTCDate());
  for (let dayStartMs = firstDayMs - DAY_MS; dayStartMs <= lastDayMs + DAY_MS; dayStartMs += DAY_MS) {
    const day = new Date(dayStartMs).getUTCDay();
    for (const w of windows) {
      if (w.day !== day) continue;
      const startMinute = hhmmToMinuteOfDay(w.start);
      const endMinute = hhmmToMinuteOfDay(w.end);
      if (startMinute == null || endMinute == null) continue;
      boundaries.add(dayStartMs + startMinute * MINUTE_MS);
      boundaries.add(dayStartMs + endMinute * MINUTE_MS);
    }
  }

  const ordered = Array.from(boundaries)
    .filter((ms) => ms > start.getTime() && ms < stop.getTime() || ms === start.getTime() || ms === stop.getTime())
    .sort((a, b) => a - b);

  const segments: TouDurationSegment[] = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const segStartMs = ordered[i];
    const segEndMs = ordered[i + 1];
    if (segEndMs <= segStartMs) continue;
    const midpoint = new Date(segStartMs + Math.floor((segEndMs - segStartMs) / 2));
    const resolved = resolveTouRateAt({
      at: midpoint,
      pricingMode: input.pricingMode,
      defaultPricePerKwhUsd: input.defaultPricePerKwhUsd,
      defaultIdleFeePerMinUsd: input.defaultIdleFeePerMinUsd,
      touWindows: input.touWindows,
    });
    const minutes = (segEndMs - segStartMs) / MINUTE_MS;
    if (minutes <= 0) continue;

    const prev = segments[segments.length - 1];
    if (
      prev
      && prev.source === resolved.source
      && prev.pricePerKwhUsd === resolved.pricePerKwhUsd
      && prev.idleFeePerMinUsd === resolved.idleFeePerMinUsd
      && new Date(prev.endedAt).getTime() === segStartMs
    ) {
      prev.endedAt = new Date(segEndMs).toISOString();
      prev.minutes = Number((prev.minutes + minutes).toFixed(6));
    } else {
      segments.push({
        startedAt: new Date(segStartMs).toISOString(),
        endedAt: new Date(segEndMs).toISOString(),
        minutes: Number(minutes.toFixed(6)),
        pricePerKwhUsd: resolved.pricePerKwhUsd,
        idleFeePerMinUsd: resolved.idleFeePerMinUsd,
        source: resolved.source,
      });
    }
  }

  return segments;
}
