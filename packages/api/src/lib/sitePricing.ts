/**
 * Server-side TOU window validation for the sites API.
 *
 * Rules:
 *  - end "00:00" = end-of-day (canonical). end "23:59" is accepted as legacy alias.
 *  - Windows must not overlap on the same day.
 *  - Overnight windows (end < start numerically) are NOT stored; the portal splits them
 *    into two adjacent same-day windows (e.g. Thu 21:00–00:00 + Fri 00:00–03:00).
 *  - Unknown fields (e.g. portal-generated `id`) are stripped on write.
 */

export type TouWindow = {
  day: number;
  start: string;
  end: string;
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function hhmmToMinutes(value: string): number {
  if (value === '00:00') return 1440; // end-of-day sentinel
  const match = HHMM_RE.exec(value);
  if (!match) return -1;
  return Number(match[1]) * 60 + Number(match[2]);
}

function normaliseEnd(end: string): string {
  return end === '23:59' ? '00:00' : end;
}

export function validateTouWindows(raw: unknown): { ok: true; windows: TouWindow[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'touWindows must be an array' };
  }

  const windows: TouWindow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `touWindows[${i}] must be an object` };
    }

    const candidate = entry as Record<string, unknown>;
    const day = Number(candidate.day);
    const start = String(candidate.start ?? '');
    const end = normaliseEnd(String(candidate.end ?? ''));
    const pricePerKwhUsd = Number(candidate.pricePerKwhUsd);
    const idleFeePerMinUsd = Number(candidate.idleFeePerMinUsd);

    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, error: `touWindows[${i}].day must be an integer 0–6` };
    }
    const startMin = hhmmToMinutes(start);
    const endMin   = hhmmToMinutes(end);
    if (startMin < 0 || endMin < 0) {
      return { ok: false, error: `touWindows[${i}] start/end must use HH:mm format (end may be 00:00 for end-of-day)` };
    }
    if (endMin <= startMin) {
      return { ok: false, error: `touWindows[${i}] end must be after start (use 00:00 for end-of-day)` };
    }
    if (!Number.isFinite(pricePerKwhUsd) || pricePerKwhUsd < 0) {
      return { ok: false, error: `touWindows[${i}].pricePerKwhUsd must be >= 0` };
    }
    if (!Number.isFinite(idleFeePerMinUsd) || idleFeePerMinUsd < 0) {
      return { ok: false, error: `touWindows[${i}].idleFeePerMinUsd must be >= 0` };
    }

    // Strip id and any unknown fields — only store canonical fields
    windows.push({ day, start, end, pricePerKwhUsd, idleFeePerMinUsd });
  }

  // Check for overlaps per day
  for (let day = 0; day < 7; day += 1) {
    const dayWindows = windows
      .filter((w) => w.day === day)
      .sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));

    for (let i = 1; i < dayWindows.length; i += 1) {
      const prev = dayWindows[i - 1];
      const curr = dayWindows[i];
      if (hhmmToMinutes(curr.start) < hhmmToMinutes(prev.end)) {
        return { ok: false, error: `touWindows overlap on day ${day}: ${prev.start}–${prev.end} and ${curr.start}–${curr.end}` };
      }
    }
  }

  return {
    ok: true,
    windows: windows.sort((a, b) => a.day - b.day || hhmmToMinutes(a.start) - hhmmToMinutes(b.start)),
  };
}
