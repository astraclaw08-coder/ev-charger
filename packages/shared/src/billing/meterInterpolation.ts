/**
 * Meter register interpolation for accurate per-TOU-segment energy billing.
 *
 * Instead of distributing total kWh proportionally by time (which is wrong when
 * power draw varies across TOU windows — e.g., smart charging), this module
 * interpolates the charger's energy register at TOU boundary timestamps to
 * compute actual kWh delivered in each segment.
 */

export type MeterReading = {
  timestamp: Date;
  wh: number; // Energy.Active.Import.Register in Wh (absolute)
};

type MeterValuePayload = {
  meterValue?: Array<{
    timestamp: string;
    sampledValue: Array<{
      measurand?: string;
      value: string;
      unit?: string;
      context?: string;
    }>;
  }>;
};

/**
 * Parse OCPP MeterValues log payloads into sorted MeterReading[].
 * Filters to Energy.Active.Import.Register with Sample.Periodic/Clock context
 * (excludes Transaction.Begin/End which may be relative offsets).
 */
export function extractMeterReadings(
  logs: Array<{ payload: unknown; createdAt: Date }>,
): MeterReading[] {
  const readings: MeterReading[] = [];
  for (const log of logs) {
    const payload = log.payload as MeterValuePayload;
    for (const mv of payload.meterValue ?? []) {
      const ts = new Date(mv.timestamp);
      if (!Number.isFinite(ts.getTime())) continue;
      for (const sv of mv.sampledValue ?? []) {
        const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
        if (measurand !== 'Energy.Active.Import.Register') continue;
        const context = sv.context ?? 'Sample.Periodic';
        if (context === 'Transaction.Begin' || context === 'Transaction.End') continue;
        const raw = Number(sv.value);
        if (!Number.isFinite(raw)) continue;
        const unit = sv.unit ?? 'Wh';
        const wh = unit === 'kWh' ? raw * 1000 : raw;
        readings.push({ timestamp: ts, wh });
      }
    }
  }
  return readings.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Linearly interpolate the energy register value at each boundary timestamp.
 * Returns one Wh value per boundary.
 *
 * - If a boundary falls before all readings, uses the first reading's value.
 * - If a boundary falls after all readings, uses the last reading's value.
 * - If readings array has fewer than 2 entries, returns null for all boundaries.
 */
export function interpolateMeterAtBoundaries(
  readings: MeterReading[],
  boundaries: Date[],
): (number | null)[] {
  if (readings.length < 2) return boundaries.map(() => null);

  return boundaries.map((boundary) => {
    const t = boundary.getTime();

    // Before all readings — clamp to first
    if (t <= readings[0].timestamp.getTime()) return readings[0].wh;
    // After all readings — clamp to last
    if (t >= readings[readings.length - 1].timestamp.getTime()) return readings[readings.length - 1].wh;

    // Find the two surrounding readings via binary search
    let lo = 0;
    let hi = readings.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (readings[mid].timestamp.getTime() <= t) lo = mid;
      else hi = mid;
    }

    const before = readings[lo];
    const after = readings[hi];
    const tBefore = before.timestamp.getTime();
    const tAfter = after.timestamp.getTime();

    if (tAfter === tBefore) return before.wh;
    const fraction = (t - tBefore) / (tAfter - tBefore);
    return before.wh + (after.wh - before.wh) * fraction;
  });
}

/**
 * Compute per-segment kWh from interpolated boundary Wh values.
 * The last segment is adjusted so the sum equals totalKwh exactly
 * (compensates for interpolation rounding vs. authoritative Transaction.End - Begin delta).
 *
 * boundaryWh has N+1 entries for N segments (start of seg 0, end of seg 0 / start of seg 1, ..., end of seg N).
 */
export function computeSegmentKwh(
  boundaryWh: (number | null)[],
  totalKwh: number,
): number[] | null {
  if (boundaryWh.length < 2) return null;

  // If any boundary is null, interpolation failed — caller should fall back
  if (boundaryWh.some((v) => v == null)) return null;

  const segments: number[] = [];
  for (let i = 0; i < boundaryWh.length - 1; i++) {
    segments.push(Math.max(0, (boundaryWh[i + 1]! - boundaryWh[i]!) / 1000));
  }

  // Adjust last segment so sum equals totalKwh exactly
  const sumBeforeLast = segments.slice(0, -1).reduce((s, v) => s + v, 0);
  segments[segments.length - 1] = Math.max(0, totalKwh - sumBeforeLast);

  return segments;
}
