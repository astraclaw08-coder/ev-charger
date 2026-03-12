export type TouWindow = {
  id?: string;
  day: number;
  start: string;
  end: string;
  pricePerKwhUsd: number;
  idleFeePerMinUsd: number;
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function hhmmToMinutes(value: string): number {
  const match = HHMM_RE.exec(value);
  if (!match) return -1;
  return Number(match[1]) * 60 + Number(match[2]);
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
    const end = String(candidate.end ?? '');
    const pricePerKwhUsd = Number(candidate.pricePerKwhUsd);
    const idleFeePerMinUsd = Number(candidate.idleFeePerMinUsd);

    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, error: `touWindows[${i}].day must be an integer between 0 and 6` };
    }
    if (hhmmToMinutes(start) < 0 || hhmmToMinutes(end) < 0) {
      return { ok: false, error: `touWindows[${i}] start/end must use HH:mm format` };
    }
    if (hhmmToMinutes(end) <= hhmmToMinutes(start)) {
      return { ok: false, error: `touWindows[${i}] end must be after start` };
    }
    if (!Number.isFinite(pricePerKwhUsd) || pricePerKwhUsd < 0) {
      return { ok: false, error: `touWindows[${i}].pricePerKwhUsd must be >= 0` };
    }
    if (!Number.isFinite(idleFeePerMinUsd) || idleFeePerMinUsd < 0) {
      return { ok: false, error: `touWindows[${i}].idleFeePerMinUsd must be >= 0` };
    }

    windows.push({
      id: typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : undefined,
      day,
      start,
      end,
      pricePerKwhUsd,
      idleFeePerMinUsd,
    });
  }

  for (let day = 0; day < 7; day += 1) {
    const dayWindows = windows
      .filter((w) => w.day === day)
      .sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
    for (let i = 1; i < dayWindows.length; i += 1) {
      const prev = dayWindows[i - 1];
      const curr = dayWindows[i];
      if (hhmmToMinutes(curr.start) < hhmmToMinutes(prev.end)) {
        return { ok: false, error: `touWindows overlap on day ${day}` };
      }
    }
  }

  const normalized = windows.sort((a, b) => a.day - b.day || hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
  return { ok: true, windows: normalized };
}
