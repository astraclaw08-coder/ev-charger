/**
 * TOU (Time-of-Use) pricing engine.
 *
 * Design principles:
 *  - Windows are stored as {day, start HH:mm, end HH:mm} in local site time.
 *  - end "00:00" means midnight-end (exclusive), i.e. the window covers through 23:59:59.
 *  - end "23:59" is accepted as a legacy alias for "00:00" (end-of-day) and normalised on read.
 *  - Overnight windows are NOT supported in the data model; instead the portal stores two
 *    adjacent windows (e.g. Thu 21:00–00:00 and Fri 00:00–03:00) which the engine merges
 *    seamlessly after the 23:59 normalisation.
 *  - splitTouDuration computes segment boundaries directly from window edges — not minute-by-minute.
 */

export type TouWindow = {
  day: number;   // 0=Sun … 6=Sat
  start: string; // HH:mm, 00:00–23:59
  end: string;   // HH:mm, 00:01–00:00 (00:00 = end-of-day = 24:00)
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
};

export type ResolvedTouRate = {
  source: 'flat' | 'tou';
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
  window: TouWindow | null;
};

export type TouDurationSegment = {
  startedAt: string;
  endedAt: string;
  minutes: number;
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
  source: 'flat' | 'tou';
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;

const WEEKDAY_TO_NUM: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
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

/** Returns { day: 0-6, minuteOfDay: 0-1439 } in the given timezone (UTC fallback). */
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
  return { day, minuteOfDay: Math.max(0, Math.min(1439, hh * 60 + mm)) };
}

/** Parse HH:mm string → minutes (0–1439). Returns null on bad input. */
function hhmmToMinuteOfDay(hhmm: string): number | null {
  const match = HHMM_RE.exec(hhmm);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Parse end time → exclusive end-minute.
 * "23:59" and "00:00" both mean end-of-day → returns 1440 (exclusive midnight).
 */
function parseEndMinute(end: string): number | null {
  if (end === '23:59' || end === '00:00') return 1440;
  return hhmmToMinuteOfDay(end);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a raw touWindows JSON array.
 * - Strips unknown fields (including portal-generated `id`).
 * - Normalises "23:59" end to the canonical "00:00" (end-of-day) form.
 * - Rejects invalid entries silently (returns only valid rows).
 * - Sorts by day, then start.
 */
export function normalizeTouWindows(raw: unknown): TouWindow[] {
  if (!Array.isArray(raw)) return [];
  const rows: TouWindow[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Record<string, unknown>;
    const day = Number(candidate.day);
    const start = String(candidate.start ?? '');
    const rawEnd = String(candidate.end ?? '');
    // Normalise 23:59 → 00:00 (canonical end-of-day)
    const end = rawEnd === '23:59' ? '00:00' : rawEnd;
    const pricePerKwhUsd = Number(candidate.pricePerKwhUsd);
    const idleFeePerMinUsd = Number(candidate.idleFeePerMinUsd);
    const startMinute = hhmmToMinuteOfDay(start);
    const endMinute = parseEndMinute(end);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (startMinute == null || endMinute == null || endMinute === startMinute) continue;
    if (!Number.isFinite(pricePerKwhUsd) || pricePerKwhUsd < 0) continue;
    if (!Number.isFinite(idleFeePerMinUsd) || idleFeePerMinUsd < 0) continue;
    rows.push({ day, start, end, pricePerKwhUsd, idleFeePerMinUsd });
  }
  rows.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return rows;
}

/**
 * Resolve the TOU rate that applies at a specific instant.
 * Falls back to flat (default) rates when no window matches.
 */
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
    return { source: 'flat', pricePerKwhUsd: defaultPricePerKwhUsd, idleFeePerMinUsd: defaultIdleFeePerMinUsd, window: null };
  }

  const { day, minuteOfDay } = localDayMinute(at, input.timeZone);
  const windows = normalizeTouWindows(input.touWindows);

  const matched = windows.find((w) => {
    const startMinute = hhmmToMinuteOfDay(w.start);
    const endMinute = parseEndMinute(w.end); // 1440 for 00:00 (end-of-day)
    if (startMinute == null || endMinute == null) return false;
    return w.day === day && minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }) ?? null;

  if (!matched) {
    return { source: 'flat', pricePerKwhUsd: defaultPricePerKwhUsd, idleFeePerMinUsd: defaultIdleFeePerMinUsd, window: null };
  }

  return { source: 'tou', pricePerKwhUsd: matched.pricePerKwhUsd, idleFeePerMinUsd: matched.idleFeePerMinUsd, window: matched };
}

/**
 * Convert a local HH:mm time on the same calendar date as `ref` (in `timeZone`) to UTC ms.
 * Uses the Swedish locale (`sv`) as a reliable ISO-like formatter for local→UTC conversion.
 */
function localHhmmToUtcMs(ref: Date, minuteOfDay: number, timeZone: string | null | undefined): number {
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;

  if (!timeZone) {
    const utcMidnight = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
    return utcMidnight + minuteOfDay * MINUTE_MS;
  }

  // Get the local calendar date string for ref in the target timezone
  const localDateStr = ref.toLocaleDateString('sv', { timeZone }); // "YYYY-MM-DD"
  // Construct the local datetime string and convert back to UTC
  const localIso = `${localDateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  // Parse as if UTC, then adjust by the timezone offset at that instant
  const naiveUtcMs = new Date(localIso + 'Z').getTime();
  // Compute the actual offset: format naiveUtcMs in the target TZ and measure drift
  const check = new Date(naiveUtcMs);
  const actualLocalStr = check.toLocaleString('sv', { timeZone }).slice(0, 16); // "YYYY-MM-DD HH:MM"
  const expectedLocalStr = `${localDateStr} ${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  const driftMs = new Date(actualLocalStr + ':00Z').getTime() - new Date(expectedLocalStr + ':00Z').getTime();
  return naiveUtcMs - driftMs;
}

/**
 * Find all candidate UTC boundary timestamps (window start/end edges) that fall
 * strictly after `fromMs` and at or before `limitMs`, looking ahead up to 3 local calendar days.
 */
function collectBoundaryTimestamps(
  fromMs: number,
  limitMs: number,
  windows: TouWindow[],
  timeZone: string | null | undefined,
): number[] {
  const candidates: number[] = [];

  for (let d = 0; d < 3; d++) {
    // Probe a reference point in the dth calendar day from fromMs
    const probeDate = new Date(fromMs + d * 86_400_000);
    const { day } = localDayMinute(probeDate, timeZone);

    for (const w of windows) {
      if (w.day !== day) continue;

      // Window start boundary
      const startMin = hhmmToMinuteOfDay(w.start);
      if (startMin != null) {
        const ts = localHhmmToUtcMs(probeDate, startMin, timeZone);
        if (ts > fromMs && ts <= limitMs) candidates.push(ts);
      }

      // Window end boundary
      const endMin = parseEndMinute(w.end); // 1440 for end-of-day
      if (endMin != null && endMin < 1440) {
        const ts = localHhmmToUtcMs(probeDate, endMin, timeZone);
        if (ts > fromMs && ts <= limitMs) candidates.push(ts);
      }
      // end-of-day (00:00) means the boundary is the start of the next local day
      if (endMin === 1440) {
        const nextDayProbe = new Date(probeDate.getTime() + 86_400_000);
        const ts = localHhmmToUtcMs(nextDayProbe, 0, timeZone);
        if (ts > fromMs && ts <= limitMs) candidates.push(ts);
      }
    }
  }

  // Deduplicate and sort
  return Array.from(new Set(candidates)).sort((a, b) => a - b);
}

/**
 * Split a time range [startedAt, stoppedAt) into TOU-priced segments.
 * Each segment has a uniform rate (same pricePerKwhUsd + idleFeePerMinUsd).
 *
 * Adjacent segments with identical rates are automatically merged.
 * Segments are computed by jumping directly to the next window boundary —
 * NOT by minute-by-minute iteration.
 */
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
  const stop  = new Date(input.stoppedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime()) || stop <= start) return [];

  const defaultPricePerKwhUsd  = Math.max(0, Number(input.defaultPricePerKwhUsd  ?? 0) || 0);
  const defaultIdleFeePerMinUsd = Math.max(0, Number(input.defaultIdleFeePerMinUsd ?? 0) || 0);
  const windows  = normalizeTouWindows(input.touWindows);
  const pricingMode = input.pricingMode;
  const timeZone = input.timeZone;

  const segments: TouDurationSegment[] = [];
  let cursorMs = start.getTime();
  const stopMs  = stop.getTime();

  // Pre-compute all boundary timestamps for the entire session range up front
  const boundaries = collectBoundaryTimestamps(cursorMs - 1, stopMs, windows, timeZone);

  while (cursorMs < stopMs) {
    const currentRate = resolveTouRateAt({
      at: new Date(cursorMs),
      pricingMode,
      defaultPricePerKwhUsd,
      defaultIdleFeePerMinUsd,
      touWindows: windows,
      timeZone,
    });

    // Find the next boundary strictly after cursorMs
    const nextBoundary = boundaries.find((b) => b > cursorMs) ?? Infinity;
    const endMs = Math.min(stopMs, nextBoundary === Infinity ? stopMs : nextBoundary);

    const minutes = (endMs - cursorMs) / MINUTE_MS;
    if (minutes > 0) {
      // Merge with previous segment if same rate (handles adjacent same-rate windows)
      const prev = segments[segments.length - 1];
      const sameRate = prev
        && prev.source === currentRate.source
        && prev.pricePerKwhUsd === currentRate.pricePerKwhUsd
        && prev.idleFeePerMinUsd === currentRate.idleFeePerMinUsd
        && new Date(prev.endedAt).getTime() === cursorMs;

      if (sameRate) {
        prev.endedAt = new Date(endMs).toISOString();
        prev.minutes = Number((prev.minutes + minutes).toFixed(6));
      } else {
        segments.push({
          startedAt: new Date(cursorMs).toISOString(),
          endedAt:   new Date(endMs).toISOString(),
          minutes:   Number(minutes.toFixed(6)),
          pricePerKwhUsd:   currentRate.pricePerKwhUsd,
          idleFeePerMinUsd: currentRate.idleFeePerMinUsd,
          source: currentRate.source,
        });
      }
    }

    cursorMs = endMs;
  }

  return segments;
}
