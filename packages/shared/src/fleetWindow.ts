/**
 * Fleet charging window evaluation (TASK-0208 Hybrid-B).
 *
 * A FleetPolicy declares one or more weekly windows in site-local time.
 * Inside the window the charger is allowed to deliver up to `maxAmps`;
 * outside the window the server MUST push a TxProfile at 0 A.
 *
 * This module answers two questions for a given instant `at`:
 *   1. Is the window currently active?
 *   2. When is the next state transition (active→inactive or vice versa)?
 *
 * Timezone handling mirrors `touPricing.ts::localDayMinute` — naive UTC
 * fallback when no timeZone is supplied, Intl-backed when provided.
 *
 * Window semantics match TouWindow:
 *   - day: 0=Sun … 6=Sat
 *   - start: "HH:mm" inclusive (00:00–23:59)
 *   - end:   "HH:mm" exclusive (00:01–00:00, where "00:00" = end-of-day = 24:00)
 *   - "23:59" accepted as legacy alias for "00:00"
 *   - Overnight windows NOT supported — operators store two adjacent days.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type FleetWindow = {
  day: number;   // 0=Sun … 6=Sat
  start: string; // HH:mm, 00:00–23:59
  end: string;   // HH:mm, 00:01–00:00
};

export type FleetWindowsJson = {
  windows: FleetWindow[];
};

export type FleetWindowEval = {
  active: boolean;
  /** The window currently matched, if active; null otherwise. */
  matchedWindow: FleetWindow | null;
  /**
   * Next instant at which `active` will flip. Null when the policy has zero
   * windows (permanently inactive) or when every minute of the week is inside
   * a window (permanently active).
   */
  nextTransitionAt: Date | null;
};

// ─── Internal helpers (mirrors touPricing.ts) ───────────────────────────────

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;

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

const WEEKDAY_TO_NUM: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

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

function hhmmToMinuteOfDay(hhmm: string): number | null {
  const match = HHMM_RE.exec(hhmm);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseEndMinute(end: string): number | null {
  if (end === '23:59' || end === '00:00') return DAY_MINUTES;
  return hhmmToMinuteOfDay(end);
}

/** Minute-of-week = day*1440 + minuteOfDay. Range [0, WEEK_MINUTES). */
function toMinuteOfWeek(day: number, minuteOfDay: number): number {
  return day * DAY_MINUTES + minuteOfDay;
}

// ─── Window parsing ─────────────────────────────────────────────────────────

/** Validate + normalize raw windowsJson. Rejects malformed entries silently. */
export function normalizeFleetWindows(raw: unknown): FleetWindow[] {
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object' && Array.isArray((raw as any).windows)) {
    list = (raw as any).windows;
  }
  if (!list) return [];

  const rows: FleetWindow[] = [];
  for (const value of list) {
    if (!value || typeof value !== 'object') continue;
    const c = value as Record<string, unknown>;
    const day = Number(c.day);
    const start = String(c.start ?? '');
    const rawEnd = String(c.end ?? '');
    const end = rawEnd === '23:59' ? '00:00' : rawEnd;
    const s = hhmmToMinuteOfDay(start);
    const e = parseEndMinute(end);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (s == null || e == null) continue;
    if (e <= s) continue; // overnight not supported — split into two days
    rows.push({ day, start, end });
  }
  rows.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return rows;
}

/**
 * Expand windows to a sorted array of [startMinOfWeek, endMinOfWeek) intervals.
 * Merges adjacent/overlapping intervals so end-of-day → start-of-next-day
 * pairs become a single contiguous range.
 */
function expandToMinuteOfWeek(windows: FleetWindow[]): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  for (const w of windows) {
    const s = hhmmToMinuteOfDay(w.start);
    const e = parseEndMinute(w.end);
    if (s == null || e == null || e <= s) continue;
    raw.push([w.day * DAY_MINUTES + s, w.day * DAY_MINUTES + e]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  // Merge adjacent ranges (including wrap at week boundary)
  const merged: Array<[number, number]> = [];
  for (const iv of raw) {
    if (merged.length === 0) { merged.push([...iv] as [number, number]); continue; }
    const last = merged[merged.length - 1];
    if (iv[0] <= last[1]) {
      last[1] = Math.max(last[1], iv[1]);
    } else {
      merged.push([...iv] as [number, number]);
    }
  }
  // Handle week wrap: if last interval ends exactly at WEEK_MINUTES and first
  // starts at 0, they are contiguous across the week boundary.
  if (merged.length >= 2
    && merged[merged.length - 1][1] === WEEK_MINUTES
    && merged[0][0] === 0) {
    merged[0][0] = merged[merged.length - 1][0] - WEEK_MINUTES;
    merged.pop();
    merged.sort((a, b) => a[0] - b[0]);
  }
  return merged;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Evaluate whether the fleet window is active at `at` and when it next flips.
 *
 * Pure function — no I/O. Safe to call from handlers, schedulers, receipts.
 */
export function evaluateFleetWindowAt(input: {
  at: Date;
  windows: unknown;
  timeZone?: string | null;
}): FleetWindowEval {
  const normalized = normalizeFleetWindows(input.windows);
  if (normalized.length === 0) {
    return { active: false, matchedWindow: null, nextTransitionAt: null };
  }

  const intervals = expandToMinuteOfWeek(normalized);
  if (intervals.length === 0) {
    return { active: false, matchedWindow: null, nextTransitionAt: null };
  }

  const { day, minuteOfDay } = localDayMinute(input.at, input.timeZone);
  const mow = toMinuteOfWeek(day, minuteOfDay);

  // Permanently-active check: intervals cover full week
  const totalCoverage = intervals.reduce((s, [a, b]) => s + (b - a), 0);
  if (totalCoverage >= WEEK_MINUTES) {
    // Find the matched raw window for diagnostic purposes
    const matched = normalized.find((w) => {
      const s = (hhmmToMinuteOfDay(w.start) ?? 0) + w.day * DAY_MINUTES;
      const e = (parseEndMinute(w.end) ?? 0) + w.day * DAY_MINUTES;
      return mow >= s && mow < e;
    }) ?? normalized[0];
    return { active: true, matchedWindow: matched, nextTransitionAt: null };
  }

  // Find current or next interval (with wrap)
  let containing: [number, number] | null = null;
  let nextStart: number | null = null;
  for (const iv of intervals) {
    const [a, b] = iv;
    if (a <= mow && mow < b) { containing = iv; break; }
    if (a > mow && (nextStart === null || a < nextStart)) nextStart = a;
  }
  // Wrap — no future interval found this week, use first interval + WEEK
  if (!containing && nextStart === null) {
    nextStart = intervals[0][0] + WEEK_MINUTES;
  }

  const minutesToTransition = containing
    ? containing[1] - mow
    : (nextStart! - mow);

  const nextTransitionAt = new Date(input.at.getTime() + minutesToTransition * MINUTE_MS);
  // Align to minute boundary (window edges live on minute boundaries)
  nextTransitionAt.setSeconds(0, 0);

  let matchedWindow: FleetWindow | null = null;
  if (containing) {
    matchedWindow = normalized.find((w) => {
      const s = (hhmmToMinuteOfDay(w.start) ?? 0) + w.day * DAY_MINUTES;
      const e = (parseEndMinute(w.end) ?? 0) + w.day * DAY_MINUTES;
      // Window may be a sub-segment of a merged interval
      const inv = [containing![0], containing![1]];
      return s < inv[1] && e > inv[0] && mow >= s && mow < e;
    }) ?? null;
  }

  return {
    active: Boolean(containing),
    matchedWindow,
    nextTransitionAt,
  };
}

/**
 * Does `idTag` match the policy's prefix? Case-sensitive.
 * Centralised here so the Authorize handler, receipts, and reports agree.
 */
export function matchesFleetPolicy(idTag: string | null | undefined, idTagPrefix: string): boolean {
  if (!idTag || !idTagPrefix) return false;
  return idTag.startsWith(idTagPrefix);
}
